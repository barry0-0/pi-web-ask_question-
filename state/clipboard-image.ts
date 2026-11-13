import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getNativeClipboard } from "@earendil-works/pi-tui";

/**
 * Local-fork addition: attach a screenshot to an answer.
 *
 * The TUI convention (see Pi's own clipboard paste) is to insert a PATH as text, never
 * binary: the model opens the file with `read`. Copied files (Finder `⌘C`) already carry
 * POSIX paths, so they are passed through untouched; a raw clipboard image is written to
 * a temp file first.
 */

export type AttachResult =
	| { ok: true; text: string }
	| { ok: false; reason: "unavailable" | "empty" };

/** Sniff the container from its magic bytes; PNG is the macOS/Windows clipboard default. */
function extensionFor(bytes: Uint8Array): string {
	const at = (i: number) => bytes[i] ?? -1;
	if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return ".png";
	if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return ".jpg";
	if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return ".gif";
	if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45)
		return ".webp";
	if (at(0) === 0x42 && at(1) === 0x4d) return ".bmp";
	return ".png";
}

/**
 * Read the clipboard as attachment text: file paths first (Finder copies), then a raw
 * image saved into the temp directory. Returns `unavailable` when the native helper is
 * missing (headless hosts, Linux without a display) and `empty` when nothing is usable.
 */
export async function readClipboardAttachment(): Promise<AttachResult> {
	const clipboard = getNativeClipboard();
	if (!clipboard) return { ok: false, reason: "unavailable" };

	try {
		const paths = await clipboard.getFilePaths?.();
		if (paths && paths.length > 0) return { ok: true, text: paths.join(" ") };
	} catch {
		// Fall through to the image read: a failed file read is not fatal.
	}

	try {
		const image = await clipboard.getImage();
		if (image && image.length > 0) {
			const file = join(tmpdir(), `pi-clipboard-${randomUUID()}${extensionFor(image)}`);
			await writeFile(file, image);
			return { ok: true, text: file };
		}
	} catch {
		return { ok: false, reason: "unavailable" };
	}

	return { ok: false, reason: "empty" };
}
