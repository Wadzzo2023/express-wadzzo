import { BlockedReason, GoogleGenAI } from "@google/genai";
import { Router, type IRouter, } from "express";
import type { Request, Response } from "express";
import type { WebSocket } from "ws";
import { logger } from "../lib/logger.js";
import { db } from "../lib/db.js";

// ── Credit costs per generation type ────────────────────────────────────────
export const MUSIC_CREDITS = {
    CLIP: 0.5,       // lyria-3-clip-preview  (~30s clip)
    FULL_SONG: 1.0,  // lyria-3-pro-preview   (full-length song)
    STREAMING: 0.3,  // lyria-realtime-exp     (per session)
} as const;

async function checkAndDeductCredits(
    userId: string,
    credits: number,
    description: string,
    metadata?: Record<string, string | number>,
): Promise<{ success: true; remainingBalance: number } | { success: false; error: string }> {
    const balance = await db.creditBalance.findUnique({
        where: { userId },
    });

    if (!balance || balance.balance < credits) {
        return {
            success: false,
            error: `Insufficient credits. Required: ${credits}, available: ${balance?.balance ?? 0}`,
        };
    }

    const updatedBalance = await db.creditBalance.update({
        where: { userId },
        data: { balance: { decrement: credits } },
    });

    await db.creditTransaction.create({
        data: {
            userId,
            amount: -credits,
            type: "USAGE",
            description,
            metadata: metadata ? JSON.parse(JSON.stringify(metadata)) : undefined,
        },
    });

    return { success: true, remainingBalance: updatedBalance.balance };
}

// ── Shared types ─────────────────────────────────────────────────────────────

interface WeightedPrompt {
    text: string;
    weight: number;
}

interface LiveMusicGenerationConfig {
    temperature?: number;
    topK?: number;
    guidance?: number;
    seed?: number;
    bpm?: number;
    density?: number;
    brightness?: number;
    scale?: string;
    muteBass?: boolean;
    muteDrums?: boolean;
    onlyBassAndDrums?: boolean;
}

interface LyriaMessage {
    setupComplete?: boolean;
    filteredPrompt?: { filteredReason: string };
    serverContent?: {
        audioChunks: Array<{ data?: string }>;
    };
}

interface LyriaSession {
    setWeightedPrompts: (params: {
        weightedPrompts: WeightedPrompt[];
    }) => Promise<void>;
    setMusicGenerationConfig: (params: {
        musicGenerationConfig: LiveMusicGenerationConfig;
    }) => Promise<void>;
    play: () => void;
    pause: () => void;
    stop: () => void;
    resetContext: () => void;
    disconnect?: () => void;
}

interface ClientMessage {
    type:
    | "connect"
    | "play"
    | "pause"
    | "stop"
    | "setPrompts"
    | "setConfig"
    | "resetContext"
    | "disconnect";
    userId?: string;
    prompts?: WeightedPrompt[];
    config?: LiveMusicGenerationConfig;
}

interface GoogleGenAILive {
    music: {
        connect: (params: {
            model: string;
            callbacks: {
                onmessage: (message: LyriaMessage) => Promise<void>;
                onerror: (error: unknown) => void;
                onclose: (event: unknown) => void;
            };
        }) => Promise<LyriaSession>;
    };
}

function getApiKey(): string {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not configured");
    return apiKey;
}

// ── REST: Full song generation ───────────────────────────────────────────────

const musicRouter: IRouter = Router();

interface GenerateBody {
    prompt: string;
    userId: string;
    model?: "lyria-3-clip-preview" | "lyria-3-pro-preview";
    format?: "mp3" | "wav";
}

musicRouter.post(
    "/generate",
    (req: Request<object, object, GenerateBody>, res: Response) => {
        void (async () => {
            try {
                const {
                    prompt,
                    userId,
                    model = "lyria-3-pro-preview",
                    format = "wav",
                } = req.body;

                if (!userId?.trim()) {
                    res.status(400).json({ error: "userId is required" });
                    return;
                }

                if (!prompt?.trim()) {
                    res.status(400).json({ error: "prompt is required" });
                    return;
                }

                const creditCost = model === "lyria-3-clip-preview"
                    ? MUSIC_CREDITS.CLIP
                    : MUSIC_CREDITS.FULL_SONG;

                const creditResult = await checkAndDeductCredits(
                    userId,
                    creditCost,
                    `Music generation: ${model === "lyria-3-clip-preview" ? "clip" : "full song"}`,
                    { model, format, prompt: prompt.substring(0, 200) },
                );

                if (!creditResult.success) {
                    res.status(402).json({
                        error: creditResult.error,
                        requiredCredits: creditCost,
                    });
                    return;
                }

                logger.info(
                    `[music] Generating full song — model=${model} format=${format}`
                );
                logger.info(`[music] Prompt: ${prompt.substring(0, 300)}`);

                // Full song generation can take several minutes
                res.setTimeout(5 * 60 * 1000);

                const ai = new GoogleGenAI({ apiKey: getApiKey() });

                // WAV is Pro-only; clip model gets no config (always MP3)
                const isProModel = model === "lyria-3-pro-preview";
                const useWav = isProModel && format === "wav";
                const defaultMime = useWav ? "audio/wav" : "audio/mp3";

                const config: Record<string, unknown> = useWav
                    ? {
                        responseModalities: ["AUDIO", "TEXT"],
                        responseFormat: {
                            audio: { mimeType: "audio/wav" },
                        },
                    }
                    : {};

                const response = await ai.models.generateContent({
                    model,
                    contents: prompt,
                    config,
                });

                // Check if prompt was blocked
                if (!response.candidates?.length) {
                    const feedback = response.promptFeedback;

                    logger.error(
                        `[music] No candidates  promptFeedback: ${JSON.stringify(feedback)}`
                    );

                    let reason = "Prompt was blocked by the model";
                    if (feedback?.blockReason === BlockedReason.OTHER) {
                        reason =
                            "Blocked: the lyrics may resemble copyrighted content, " +
                            "or the prompt triggered a content filter. " +
                            "Try with original lyrics or a simpler description.";
                    } else if (feedback?.blockReason === BlockedReason.SAFETY) {
                        reason =
                            "Blocked: prompt was flagged by safety filters.";
                    }

                    res.status(400).json({
                        error: reason,
                        blockReason: feedback?.blockReason,
                    });
                    return;
                }

                const parts =
                    response.candidates[0]?.content?.parts ?? [];

                if (parts.length === 0) {
                    res.status(500).json({
                        error: "No parts in response from Lyria",
                    });
                    return;
                }

                let audioData: string | null = null;
                let audioMimeType = defaultMime;
                let textResponse = "";

                for (const part of parts) {
                    if (part.inlineData?.data) {
                        audioData = part.inlineData.data;
                        audioMimeType =
                            part.inlineData.mimeType ?? defaultMime;
                    }
                    if (part.text) {
                        textResponse += part.text;
                    }
                }

                if (!audioData) {
                    res.status(500).json({
                        error:
                            "No audio generated — model returned text only",
                        text: textResponse || undefined,
                    });
                    return;
                }

                logger.info(
                    `[music] Full song generated (${audioMimeType}, ${Math.round(audioData.length / 1024)}KB base64)`
                );

                res.json({
                    audio: audioData,
                    mimeType: audioMimeType,
                    text: textResponse || undefined,
                    creditsUsed: creditCost,
                    remainingBalance: creditResult.remainingBalance,
                });
            } catch (error) {
                const msg =
                    error instanceof Error
                        ? error.message
                        : String(error);
                const stack =
                    error instanceof Error ? error.stack : undefined;
                logger.error(
                    "[music] Generation failed:",
                    msg,
                    stack
                );
                res.status(500).json({ error: msg });
            }
        })();
    }
);

musicRouter.get("/credits", (_req: Request, res: Response) => {
    res.json({
        costs: {
            clip: MUSIC_CREDITS.CLIP,
            fullSong: MUSIC_CREDITS.FULL_SONG,
            streaming: MUSIC_CREDITS.STREAMING,
        },
    });
});

musicRouter.get(
    "/check-balance",
    (req: Request, res: Response) => {
        void (async () => {
            try {
                const userId = req.query.userId as string | undefined;
                if (!userId?.trim()) {
                    res.status(400).json({ error: "userId query param is required" });
                    return;
                }

                const balance = await db.creditBalance.findUnique({
                    where: { userId },
                });

                res.json({
                    balance: balance?.balance ?? 0,
                    costs: {
                        clip: MUSIC_CREDITS.CLIP,
                        fullSong: MUSIC_CREDITS.FULL_SONG,
                        streaming: MUSIC_CREDITS.STREAMING,
                    },
                });
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error("[music] Check balance failed:", msg);
                res.status(500).json({ error: msg });
            }
        })();
    }
);

export default musicRouter;

// ── WebSocket: Real-time streaming ───────────────────────────────────────────

const OPEN = 1;

export function handleMusicWebSocket(ws: WebSocket): void {
    let apiKey: string;
    try {
        apiKey = getApiKey();
    } catch {
        ws.send(
            JSON.stringify({
                type: "error",
                message: "GEMINI_API_KEY not configured on server",
            })
        );
        ws.close();
        return;
    }

    const ai = new GoogleGenAI({ apiKey, apiVersion: "v1alpha" });
    const live = (ai as unknown as { live: GoogleGenAILive }).live;

    let session: LyriaSession | null = null;
    let isConnected = false;
    let isConnecting = false;
    let wsUserId: string | null = null;
    let sessionCreditCharged = false;

    const send = (data: object) => {
        if (ws.readyState === OPEN) {
            ws.send(JSON.stringify(data));
        }
    };

    const connectToLyria = async () => {
        if (isConnecting || isConnected) return;
        isConnecting = true;
        send({ type: "connecting" });

        const maxRetries = 3;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                logger.info(
                    `[music] Connecting to Lyria (attempt ${attempt}/${maxRetries})`
                );

                if (attempt > 1) {
                    await new Promise((r) =>
                        setTimeout(r, 1000 * (attempt - 1))
                    );
                }

                session = await live.music.connect({
                    model: "lyria-realtime-exp",
                    callbacks: {
                        onmessage: async (message: LyriaMessage) => {
                            if (message.setupComplete) {
                                isConnected = true;
                                isConnecting = false;
                                send({ type: "setupComplete" });
                                logger.info(
                                    "[music] Lyria setup complete"
                                );
                            }

                            if (message.filteredPrompt) {
                                send({
                                    type: "filteredPrompt",
                                    reason: message.filteredPrompt
                                        .filteredReason,
                                });
                            }

                            if (
                                message.serverContent?.audioChunks
                                    ?.length
                            ) {
                                for (const chunk of message
                                    .serverContent.audioChunks) {
                                    if (chunk.data) {
                                        send({
                                            type: "audio",
                                            data: chunk.data,
                                        });
                                    }
                                }
                            }
                        },
                        onerror: (error: unknown) => {
                            const msg =
                                error instanceof Error
                                    ? error.message
                                    : String(error);
                            logger.error(
                                "[music] Lyria error:",
                                msg
                            );
                            isConnected = false;
                            isConnecting = false;
                            send({
                                type: "error",
                                message:
                                    msg || "Lyria connection error",
                            });
                        },
                        onclose: () => {
                            logger.info(
                                "[music] Lyria session closed"
                            );
                            isConnected = false;
                            isConnecting = false;
                            send({ type: "closed" });
                        },
                    },
                });

                await new Promise((r) => setTimeout(r, 2000));

                if (!isConnected) {
                    await new Promise((r) => setTimeout(r, 3000));
                }

                if (isConnected) {
                    send({ type: "connected" });
                    logger.info(
                        "[music] Successfully connected to Lyria"
                    );
                    return;
                }
            } catch (error) {
                const msg =
                    error instanceof Error
                        ? error.message
                        : String(error);
                logger.error(
                    `[music] Connection attempt ${attempt} failed:`,
                    msg
                );

                if (session) {
                    try {
                        session.disconnect?.();
                    } catch {
                        // ignore
                    }
                    session = null;
                }

                if (attempt === maxRetries) {
                    isConnecting = false;
                    send({
                        type: "error",
                        message: `Failed to connect after ${maxRetries} attempts: ${msg}`,
                    });
                    return;
                }
            }
        }

        isConnecting = false;
        send({
            type: "error",
            message: "Failed to connect — setup did not complete",
        });
    };

    ws.on("message", (raw: Buffer | string) => {
        void (async () => {
            try {
                const msg: ClientMessage = JSON.parse(
                    raw.toString()
                );

                switch (msg.type) {
                    case "connect":
                        if (!msg.userId?.trim()) {
                            send({ type: "error", message: "userId is required" });
                            return;
                        }
                        wsUserId = msg.userId;
                        sessionCreditCharged = false;
                        await connectToLyria();
                        break;
                    case "play":
                        if (!wsUserId) {
                            send({ type: "error", message: "Not authenticated. Send userId with connect." });
                            return;
                        }
                        if (session) {
                            if (!sessionCreditCharged) {
                                const creditResult = await checkAndDeductCredits(
                                    wsUserId,
                                    MUSIC_CREDITS.STREAMING,
                                    "Music streaming: real-time session",
                                    { model: "lyria-realtime-exp" },
                                );
                                if (!creditResult.success) {
                                    send({
                                        type: "error",
                                        message: creditResult.error,
                                        requiredCredits: MUSIC_CREDITS.STREAMING,
                                    } as object);
                                    return;
                                }
                                sessionCreditCharged = true;
                                send({
                                    type: "creditsDeducted",
                                    creditsUsed: MUSIC_CREDITS.STREAMING,
                                    remainingBalance: creditResult.remainingBalance,
                                });
                            }
                            session.play();
                        }
                        break;
                    case "pause":
                        if (session) session.pause();
                        break;
                    case "stop":
                        if (session) session.stop();
                        break;
                    case "setPrompts":
                        if (session && msg.prompts) {
                            await session.setWeightedPrompts({
                                weightedPrompts: msg.prompts,
                            });
                        }
                        break;
                    case "setConfig":
                        if (session && msg.config) {
                            await session.setMusicGenerationConfig({
                                musicGenerationConfig: msg.config,
                            });
                        }
                        break;
                    case "resetContext":
                        if (session) session.resetContext();
                        break;
                    case "disconnect":
                        if (session) {
                            session.disconnect?.();
                            session = null;
                            isConnected = false;
                        }
                        break;
                }
            } catch (error) {
                const msg =
                    error instanceof Error
                        ? error.message
                        : String(error);
                logger.error(
                    "[music] Message handling error:",
                    msg
                );
                send({ type: "error", message: msg });
            }
        })();
    });

    ws.on("close", () => {
        logger.info("[music] Client disconnected");
        if (session) {
            try {
                session.disconnect?.();
            } catch {
                // ignore
            }
            session = null;
        }
        isConnected = false;
        isConnecting = false;
    });

    ws.on("error", (err: Error) => {
        logger.error("[music] WebSocket error:", err.message);
    });
}
