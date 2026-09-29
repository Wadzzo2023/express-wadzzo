// src/lib/transcode.ts
//
// ffmpeg recipes for streaming: a full AAC track for owners and a 30s preview
// for everyone else. Pure argument builders + thin process wrappers.

import { spawn } from "child_process";
import { randomBytes } from "crypto";

export const PREVIEW_SECONDS = 30;
const LOUDNORM = "loudnorm=I=-14:TP=-1.5:LRA=11";
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

/** 30s from the creator's chosen start, pulled back so it fits inside the track. */
export function previewWindow(duration: number, startSec: number) {
    const length = Math.min(PREVIEW_SECONDS, duration);
    const start = Math.min(Math.max(0, startSec), Math.max(0, duration - length));
    return { start, length };
}

export function fullArgs(input: string, output: string): string[] {
    return [
        "-hide_banner", "-y", "-i", input,
        "-vn", "-map_metadata", "-1",
        "-af", LOUDNORM,
        "-c:a", "aac", "-b:a", "256k", "-ar", "44100",
        "-movflags", "+faststart",
        output,
    ];
}

export function previewArgs(input: string, output: string, window: { start: number; length: number }): string[] {
    const fadeOut = Math.max(0, window.length - 2);
    return [
        "-hide_banner", "-y",
        "-ss", String(window.start), "-t", String(window.length), "-i", input,
        "-vn", "-map_metadata", "-1",
        "-af", `afade=t=in:st=0:d=1,afade=t=out:st=${fadeOut}:d=2,${LOUDNORM}`,
        "-c:a", "aac", "-b:a", "128k", "-ar", "44100",
        "-movflags", "+faststart",
        output,
    ];
}

/** A fresh random folder per transcode: the bucket may be public-read. */
export function streamKeys(assetId: number) {
    const dir = `stream/${assetId}/${randomBytes(16).toString("hex")}`;
    return { full: `${dir}/full.m4a`, preview: `${dir}/preview.m4a` };
}

function run(bin: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (d: Buffer) => (out += d.toString()));
        child.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
        child.on("error", reject);
        child.on("close", (code) =>
            code === 0 ? resolve(out) : reject(new Error(`${bin} exited ${code}: ${err.trim().split("\n").at(-1)}`)),
        );
    });
}

export async function probeDuration(input: string): Promise<number> {
    const out = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", input]);
    const seconds = Number.parseFloat(out.trim());
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("Could not read audio duration");
    return seconds;
}

export const ffmpeg = (args: string[]) => run(FFMPEG, args);
