/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CspPolicies, ImageSrc } from "@main/csp";
import { fetchBuffer } from "@main/utils/http";
import { spawn } from "child_process";
import { IpcMainInvokeEvent } from "electron";
import { text } from "stream/consumers";

import type { DbConfig } from "./libsql";
import { importSponsorsCsv } from "./parser";
import { type Context, verifyReceipt } from "./receipt";

export type { Context };

function spawnWithInput(command: string, args: string[], input: Buffer) {
    const proc = spawn(command, args);
    proc.stdin.write(input);
    proc.stdin.end();

    return text(proc.stdout);
}

const pdfInfo = (pdfData: Buffer) => spawnWithInput("pdfinfo", ["-"], pdfData);
const pdfText = (pdfData: Buffer) => spawnWithInput("pdftotext", ["-layout", "-", "-"], pdfData);

export async function checkReceipt(_event: IpcMainInvokeEvent, receiptFileURL: string, ctx: Context, dbConfig: DbConfig, githubToken: string) {
    const url = new URL(receiptFileURL);
    if (url.host !== "cdn.discordapp.com" || !url.pathname.startsWith("/attachments/")) {
        throw new Error("Invalid receipt file URL");
    }

    const pdfData = await fetchBuffer(receiptFileURL);

    const [info, text] = await Promise.all([
        pdfInfo(pdfData),
        pdfText(pdfData)
    ]);

    return verifyReceipt(info, text, ctx, dbConfig, githubToken);
}

export function importCsv(_event: IpcMainInvokeEvent, csv: string, dbConfig: DbConfig) {
    return importSponsorsCsv(csv, dbConfig);
}

CspPolicies["avatars.githubusercontent.com"] = ImageSrc;
