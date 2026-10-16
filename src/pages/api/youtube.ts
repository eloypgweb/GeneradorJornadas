import { createReadStream } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import ffmpegPath from "ffmpeg-static";
import youtubedl from "youtube-dl-exec";

export const prerender = false;

const MAX_BODY_BYTES = 8_192;
const MAX_DURATION_SECONDS = 7_200;
const ALLOWED_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);

type ConversionRequest = {
	url?: unknown;
	format?: unknown;
	quality?: unknown;
};

function json(data: Record<string, string>, status = 400) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

function getSafeYoutubeUrl(value: unknown) {
	if (typeof value !== "string" || value.length > 2_048) return null;

	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return null;
		return url.toString();
	} catch {
		return null;
	}
}

function getFilename(value: string) {
	return value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 100) || "youtube-download";
}

export async function POST({ request }: { request: Request }) {
	if (!ffmpegPath) return json({ error: "FFmpeg no esta disponible en este servidor." }, 503);

	const contentLength = Number(request.headers.get("content-length") ?? 0);
	if (contentLength > MAX_BODY_BYTES) return json({ error: "La solicitud es demasiado grande." }, 413);

	let body: ConversionRequest;
	try {
		body = await request.json();
	} catch {
		return json({ error: "La solicitud debe ser JSON valido." });
	}

	const url = getSafeYoutubeUrl(body.url);
	const format = body.format === "mp4" ? "mp4" : body.format === "mp3" ? "mp3" : null;
	const quality = body.quality === "best" || body.quality === "320" || body.quality === "256" ? body.quality : null;
	if (!url || !format || !quality) return json({ error: "URL, formato o calidad no validos." });

	const workDirectory = await mkdtemp(join(tmpdir(), "generador-jornadas-"));
	const outputTemplate = join(workDirectory, "download.%(ext)s");

	try {
		const options = {
			noPlaylist: true,
			maxFilesize: "500M",
			matchFilter: `duration <= ${MAX_DURATION_SECONDS}`,
			ffmpegLocation: ffmpegPath,
			output: outputTemplate,
			...(format === "mp3"
				? {
					extractAudio: true,
					audioFormat: "mp3",
					audioQuality: quality === "best" ? "0" : quality,
				}
				: {
					format: quality === "best" ? "bv*+ba/b" : `bv*[height<=${quality === "320" ? "1080" : "720"}]+ba/b`,
					mergeOutputFormat: "mp4",
				}),
		};

		await youtubedl(url, options);
		const files = await readdir(workDirectory);
		const filename = files.find((file) => file.endsWith(`.${format}`));
		if (!filename) throw new Error("El conversor no genero un archivo valido.");

		const filePath = join(workDirectory, filename);
		const fileStats = await stat(filePath);
		const title = getFilename(filename.replace(new RegExp(`\\.${format}$`), ""));
		const stream = createReadStream(filePath);
		const cleanup = () => void rm(workDirectory, { recursive: true, force: true });
		stream.once("close", cleanup);
		stream.once("error", cleanup);

		return new Response(Readable.toWeb(stream) as ReadableStream, {
			headers: {
				"content-type": format === "mp3" ? "audio/mpeg" : "video/mp4",
				"content-length": String(fileStats.size),
				"content-disposition": `attachment; filename="${title}.${format}"`,
				"cache-control": "no-store",
			},
		});
	} catch (error) {
		await rm(workDirectory, { recursive: true, force: true });
		console.error("YouTube conversion failed", error instanceof Error ? error.message : error);
		return json({ error: "No se pudo convertir el video. Comprueba el enlace e intentalo de nuevo." }, 502);
	}
}

export function ALL() {
	return json({ error: "Metodo no permitido." }, 405);
}
