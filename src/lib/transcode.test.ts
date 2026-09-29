import { test } from "node:test";
import assert from "node:assert/strict";

import { fullArgs, previewArgs, previewWindow, stemArgs, streamKeys } from "./transcode.js";

test("preview window starts where the creator chose", () => {
    assert.deepEqual(previewWindow(240, 60), { start: 60, length: 30 });
});

test("preview window is pulled back so it never runs past the end", () => {
    assert.deepEqual(previewWindow(100, 90), { start: 70, length: 30 });
});

test("tracks shorter than 30s preview in full", () => {
    assert.deepEqual(previewWindow(12.5, 5), { start: 0, length: 12.5 });
});

test("negative or missing start means the beginning", () => {
    assert.deepEqual(previewWindow(200, -3), { start: 0, length: 30 });
});

test("full stream: AAC 256k, loudness-normalised, faststart, no video/metadata", () => {
    const args = fullArgs("in.wav", "out.m4a");
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    assert.equal(at("-i"), "in.wav");
    assert.equal(at("-c:a"), "aac");
    assert.equal(at("-b:a"), "256k");
    assert.equal(at("-movflags"), "+faststart");
    assert.ok(args.includes("-vn"));
    assert.match(at("-af") ?? "", /loudnorm=I=-14/);
    assert.equal(args.at(-1), "out.m4a");
});

test("preview: seeks before input, 30s, fades in and out, 128k", () => {
    const args = previewArgs("in.mp3", "p.m4a", { start: 42, length: 30 });
    assert.ok(args.indexOf("-ss") < args.indexOf("-i"), "fast seek before -i");
    assert.equal(args[args.indexOf("-ss") + 1], "42");
    assert.equal(args[args.indexOf("-t") + 1], "30");
    assert.equal(args[args.indexOf("-b:a") + 1], "128k");
    const af = args[args.indexOf("-af") + 1] ?? "";
    assert.match(af, /afade=t=in:st=0:d=1/);
    assert.match(af, /afade=t=out:st=28:d=2/);
});

test("stream keys live under stream/{assetId}/ with an unguessable segment", () => {
    const a = streamKeys(5);
    const b = streamKeys(5);
    assert.match(a.full, /^stream\/5\/[0-9a-f]{32}\/full\.m4a$/);
    assert.match(a.preview, /^stream\/5\/[0-9a-f]{32}\/preview\.m4a$/);
    assert.notEqual(a.full, b.full);
});

test("stems: AAC 256k with no loudness normalisation, so they still add up to the mix", () => {
    const args = stemArgs("vocals.wav", "0.m4a");
    assert.equal(args[args.indexOf("-b:a") + 1], "256k");
    assert.equal(args[args.indexOf("-movflags") + 1], "+faststart");
    assert.ok(!args.join(" ").includes("loudnorm"));
    assert.ok(!args.includes("-af"));
    assert.equal(args.at(-1), "0.m4a");
});

test("stem keys sit in the asset's stream folder, one per track index", () => {
    const keys = streamKeys(5);
    const dir = keys.full.replace(/\/full\.m4a$/, "");
    assert.equal(keys.stem(0), `${dir}/stems/0.m4a`);
    assert.equal(keys.stem(11), `${dir}/stems/11.m4a`);
});
