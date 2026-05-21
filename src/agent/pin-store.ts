import { Pin } from "./types";

interface PinStoreEntry {
    pins: Pin[];
    searchType: "LANDMARK" | "EVENT";
    total: number;
}

let pinStore: PinStoreEntry | null = null;

export function storePins(pins: Pin[], searchType: "LANDMARK" | "EVENT"): void {
    pinStore = { pins, searchType, total: pins.length };
    console.log(`[pinStore] Stored ${pins.length} pins`);
}

export function retrievePins(): PinStoreEntry | null {
    return pinStore;
}

export function clearPins(): void {
    pinStore = null;
}