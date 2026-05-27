// src/lib/google-place-enrichment.ts
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { s3Client } from "./s3.js"; // adjust path to your s3 module

import crypto from "crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PlaceEnrichment {
    imageUrl: string | null;
}

// ─── Google Places helpers ────────────────────────────────────────────────────

/**
 * Fetch the first photo reference and website URL for a place.
 * Uses the Places Details API (v1 field mask).
 */
async function fetchGooglePlaceDetails(gPlaceId: string): Promise<{
    photoName: string | null;
}> {
    const apiKey = process.env.GOOGLE_MAP_API_KEY; // add this to your env

    const url =
        `https://places.googleapis.com/v1/places/${encodeURIComponent(gPlaceId)}` +
        `?fields=photos&key=${apiKey}`;

    const res = await fetch(url, {
        headers: { "Content-Type": "application/json" },
    });

    if (!res.ok) {
        throw new Error(
            `Google Places API error ${res.status}: ${await res.text()}`
        );
    }

    const data = (await res.json()) as {
        photos?: { name: string }[];
    };

    return {
        photoName: data.photos?.[0]?.name ?? null,
    };
}

/**
 * Build a photo media URL from a Places photo resource name.
 * Returns a fetchable HTTPS URL for the full-resolution image.
 */
function buildPlacePhotoUrl(photoName: string, maxWidth = 1200): string {
    const apiKey = process.env.GOOGLE_MAP_API_KEY;
    return (
        `https://places.googleapis.com/v1/${photoName}/media` +
        `?maxWidthPx=${maxWidth}&key=${apiKey}&skipHttpRedirect=true`
    );
}

// ─── S3 upload helper ─────────────────────────────────────────────────────────

/**
 * Download an image from `sourceUrl` and upload it to S3.
 * Returns the public S3 URL.
 */
async function uploadImageFromUrlToS3(sourceUrl: string): Promise<string> {
    // 1. Fetch the image bytes
    const imageRes = await fetch(sourceUrl);
    if (!imageRes.ok) {
        throw new Error(
            `Failed to fetch image from Google (${imageRes.status}): ${sourceUrl}`
        );
    }

    const contentType = imageRes.headers.get("content-type") ?? "image/jpeg";
    const buffer = Buffer.from(await imageRes.arrayBuffer());

    // 2. Generate a random key (same pattern as your existing getSignedURL helper)
    const key = crypto.randomBytes(32).toString("hex");

    // 3. Put directly into S3 (server-side, no presigned URL needed)
    await s3Client.send(
        new PutObjectCommand({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: key,
            Body: buffer,
            ContentType: contentType,
            ContentLength: buffer.byteLength,
        })
    );

    // 4. Return the public URL
    return `https://${process.env.AWS_BUCKET_NAME}.s3.amazonaws.com/${key}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Given a Google Place ID, fetch its photo + website and upload the photo to S3.
 *
 * Returns { imageUrl, websiteUrl } — either field may be null if not available.
 *
 * Throws on unrecoverable errors (network failure, bad API key, etc.) so the
 * caller can decide whether to skip or fail the whole pin.
 */
export async function enrichPinFromGooglePlace(
    gPlaceId: string
): Promise<PlaceEnrichment> {
    const { photoName } = await fetchGooglePlaceDetails(gPlaceId);

    let imageUrl: string | null = null;

    if (photoName) {
        const photoMediaUrl = buildPlacePhotoUrl(photoName);

        // Google returns a JSON wrapper when skipHttpRedirect=true
        const mediaRes = await fetch(photoMediaUrl, {
            headers: { "Content-Type": "application/json" },
        });
        if (!mediaRes.ok) {
            throw new Error(
                `Google photo media error ${mediaRes.status}: ${photoName}`
            );
        }

        const mediaData = (await mediaRes.json()) as { photoUri?: string };
        const directPhotoUrl = mediaData.photoUri;

        if (directPhotoUrl) {
            imageUrl = await uploadImageFromUrlToS3(directPhotoUrl);
        }
    }

    return { imageUrl };
}