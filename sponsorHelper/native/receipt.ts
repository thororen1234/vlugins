/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { checkGithubUser } from "./database";
import type { DbConfig } from "./libsql";
import { findSponsorData } from "./parser";

export type Context = Record<"userId" | "channelId" | "channelName" | "messageId", string>;

export async function verifyReceipt(info: string, text: string, ctx: Context, dbConfig: DbConfig, githubToken: string) {
    const createdByPrawn = /Creator:\s*Prawn/.test(info);
    // text is in format 2026-04-05 04:00PM PDT. Extract the date part and parse it into a Date object
    const dateText = text.match(/Date\s*(\d{4}-\d{2}-\d{2})/i)?.[1];
    const date = dateText && new Date(dateText);

    const githubUsername = text.match(/Account billed\s+([A-Z0-9-]+)/i)?.[1];
    const transactionId = text.match(/Transaction ID\s+(ch_\S+)/i)?.[1];

    if (!date || !createdByPrawn || !githubUsername || !transactionId) {
        throw new Error("Invalid receipt file");
    }

    const data = await findSponsorData(transactionId, dbConfig);
    if (!data) {
        throw new Error("No sponsorship data found for this receipt");
    }

    const ids = await checkGithubUser(data.username, transactionId, ctx, dbConfig, githubToken);

    return { createdByPrawn, date, githubUsername, transactionId, data, ids };
}
