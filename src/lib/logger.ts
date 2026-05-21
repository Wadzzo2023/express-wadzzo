// src/lib/logger.ts
import winston from "winston";

const { combine, timestamp, colorize, printf, json } = winston.format;

const devFormat = printf(({ level, message, timestamp: ts, ...meta }) => {
    const metaStr = Object.keys(meta).length ? `\n  ${JSON.stringify(meta, null, 2)}` : "";
    return `${ts} [${level}] ${message}${metaStr}`;
});

export const logger = winston.createLogger({
    level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug"),
    format:
        process.env.NODE_ENV === "production"
            ? combine(timestamp(), json())
            : combine(timestamp({ format: "HH:mm:ss" }), colorize(), devFormat),
    transports: [new winston.transports.Console()],
});