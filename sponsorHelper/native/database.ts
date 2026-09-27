/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { type DbConfig, execScript, executeAll } from "./libsql";
import type { Context } from "./receipt";

let schemaReady: Promise<void> | null = null;

export function prepareDB(config: DbConfig) {
    schemaReady ??= execScript(config, `
        CREATE TABLE IF NOT EXISTS sponsors (
            githubId TEXT PRIMARY KEY,
            discordId TEXT NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS receipts (
            transactionId TEXT PRIMARY KEY,
            githubUserId TEXT NOT NULL,
            channelId TEXT NOT NULL,
            channelName TEXT,
            messageId TEXT NOT NULL,
            checkedAt INTEGER NOT NULL DEFAULT (unixepoch()),
            FOREIGN KEY (githubUserId) REFERENCES sponsors(githubId)
        ) STRICT;

        CREATE TABLE IF NOT EXISTS transactions (
            transactionId TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            country TEXT NOT NULL,
            amountInCents INTEGER NOT NULL,
            sponsorshipStartedOn INTEGER
        ) STRICT;

        CREATE INDEX IF NOT EXISTS transactions_username ON transactions(username);
    `).catch(e => {
        schemaReady = null;
        throw e;
    });

    return schemaReady;
}

export async function checkGithubUser(username: string, transactionId: string, ctx: Context, config: DbConfig, githubToken: string) {
    const res = await fetch(`https://api.github.com/users/${username}`, {
        headers: {
            "User-Agent": "Vencord Sponsor Helper",
            ...(githubToken && { "Authorization": `BEARER ${githubToken}` })
        }
    });
    if (!res.ok) throw new Error(`GitHub user lookup failed: ${res.status} ${res.statusText}`);

    const { id: githubAccountId } = await res.json();

    await prepareDB(config);

    const [[sponsorRow], [receiptRow]] = await executeAll(config, [
        {
            sql: `
                INSERT INTO sponsors (githubId, discordId)
                VALUES (?, ?)
                ON CONFLICT(githubId) DO UPDATE SET githubId=excluded.githubId
                RETURNING discordId
            `,
            args: [String(githubAccountId), ctx.userId]
        },
        {
            sql: `
                INSERT INTO receipts (transactionId, githubUserId, channelId, channelName, messageId)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(transactionId) DO UPDATE SET transactionId=excluded.transactionId
                RETURNING channelId, channelName, messageId, checkedAt
            `,
            args: [transactionId, String(githubAccountId), ctx.channelId, ctx.channelName || null, ctx.messageId]
        }
    ]);

    return {
        userId: sponsorRow.discordId as string,
        channelId: receiptRow.channelId as string,
        channelName: receiptRow.channelName as string | null,
        messageId: receiptRow.messageId as string,
        checkedAt: receiptRow.checkedAt as number
    };
}
