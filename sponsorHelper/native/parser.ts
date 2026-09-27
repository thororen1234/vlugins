/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { alpha3ToCountryName, alpha3ToEmoji, normaliseCountry } from "./countries";
import { type ParsedCSVRow, parseHeadersAndRows } from "./csvjs";
import { prepareDB } from "./database";
import { type DbConfig, executeAll } from "./libsql";

const IMPORT_CHUNK_SIZE = 500;

export interface SponsorData {
    username: string;
    country: Record<"name" | "emoji", string>;
    totalSponsorshipAmountInCents: number;
    firstSponsorshipDate: Date;
}

/** format: $5.00 */
function parseDollarAmountInCent(amount: string) {
    return Math.round(parseFloat(amount.replace(/[$,]/g, "")) * 100);
}

function parseUnixTime(date: string) {
    const time = new Date(date).getTime();
    return Number.isNaN(time) ? null : Math.floor(time / 1000);
}

export async function importSponsorsCsv(csv: string, config: DbConfig) {
    const { headers, rows } = parseHeadersAndRows(csv);

    const makeColumnGetter = (header: string) => {
        const index = headers.indexOf(header);
        if (index === -1) throw new Error(`CSV is missing the "${header}" column`);
        return (row: ParsedCSVRow) => String(row[index] ?? "");
    };

    const getUsername = makeColumnGetter("Sponsor Handle");
    const getTransactionId = makeColumnGetter("Transaction ID");
    const getCountry = makeColumnGetter("Country");
    const getProcessedAmount = makeColumnGetter("Processed Amount");
    const getSponsorshipStartedOn = makeColumnGetter("Sponsorship Started On");

    const transactions = rows
        .filter(row => getTransactionId(row) && getUsername(row))
        .map(row => [
            getTransactionId(row),
            getUsername(row),
            getCountry(row),
            parseDollarAmountInCent(getProcessedAmount(row)),
            parseUnixTime(getSponsorshipStartedOn(row))
        ]);

    await prepareDB(config);

    for (let i = 0; i < transactions.length; i += IMPORT_CHUNK_SIZE) {
        const chunk = transactions.slice(i, i + IMPORT_CHUNK_SIZE);

        await executeAll(config, [{
            sql: `
                INSERT INTO transactions (transactionId, username, country, amountInCents, sponsorshipStartedOn)
                VALUES ${chunk.map(() => "(?, ?, ?, ?, ?)").join(", ")}
                ON CONFLICT(transactionId) DO UPDATE SET
                    username=excluded.username,
                    country=excluded.country,
                    amountInCents=excluded.amountInCents,
                    sponsorshipStartedOn=excluded.sponsorshipStartedOn
            `,
            args: chunk.flat()
        }]);
    }

    return transactions.length;
}

export async function findSponsorData(transactionId: string, config: DbConfig): Promise<SponsorData | null> {
    await prepareDB(config);

    const [[entry]] = await executeAll(config, [{
        sql: `
            SELECT
                t.username,
                t.country,
                SUM(a.amountInCents) AS totalInCents,
                MIN(a.sponsorshipStartedOn) AS firstStartedOn
            FROM transactions t
            JOIN transactions a ON a.username = t.username
            WHERE t.transactionId = ?
            GROUP BY t.transactionId
        `,
        args: [transactionId]
    }]);
    if (!entry) return null;

    const country = normaliseCountry(entry.country as string);

    return {
        username: entry.username as string,
        country: {
            name: alpha3ToCountryName(country) ?? country,
            emoji: alpha3ToEmoji(country)
        },
        totalSponsorshipAmountInCents: entry.totalInCents as number,
        firstSponsorshipDate: new Date((entry.firstStartedOn as number) * 1000)
    };
}
