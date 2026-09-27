/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface DbConfig {
    url: string;
    username: string;
    password: string;
}

type SqlArg = string | number | bigint | null;
type HranaValue =
    | { type: "null"; }
    | { type: "integer"; value: string; }
    | { type: "float"; value: number; }
    | { type: "text"; value: string; }
    | { type: "blob"; base64: string; };

export interface Statement {
    sql: string;
    args?: SqlArg[];
}

export type Row = Record<string, string | number | null>;

function encodeArg(arg: SqlArg): HranaValue {
    if (arg === null) return { type: "null" };
    if (typeof arg === "bigint") return { type: "integer", value: arg.toString() };
    if (typeof arg === "number") {
        return Number.isInteger(arg)
            ? { type: "integer", value: String(arg) }
            : { type: "float", value: arg };
    }
    return { type: "text", value: arg };
}

function decodeValue(value: HranaValue) {
    switch (value.type) {
        case "null": return null;
        case "integer": return Number(value.value);
        case "float": return value.value;
        case "text": return value.value;
        case "blob": return value.base64;
    }
}

function getBaseUrl(url: string) {
    url = url.trim().replace(/\/+$/, "").replace(/^libsql:\/\//i, "https://");
    return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

async function pipeline(config: DbConfig, requests: object[]) {
    if (!config.url || !config.username || !config.password) {
        throw new Error("SponsorHelper database is not configured, set it in the plugin settings");
    }

    const res = await fetch(`${getBaseUrl(config.url)}/v2/pipeline`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Basic ${btoa(`${config.username}:${config.password}`)}`
        },
        body: JSON.stringify({ requests: [...requests, { type: "close" }] })
    });

    if (!res.ok) {
        throw new Error(`Database request failed: ${res.status} ${await res.text().catch(() => res.statusText)}`);
    }

    const { results } = await res.json();
    for (const result of results) {
        if (result.type === "error") throw new Error(`Database error: ${result.error.message}`);
    }

    return results.slice(0, -1).map(r => r.response);
}

export async function execScript(config: DbConfig, sql: string) {
    await pipeline(config, [{ type: "sequence", sql }]);
}

export async function executeAll(config: DbConfig, statements: Statement[]): Promise<Row[][]> {
    const responses = await pipeline(config, statements.map(({ sql, args = [] }) => ({
        type: "execute",
        stmt: { sql, args: args.map(encodeArg) }
    })));

    return responses.map(({ result }) =>
        result.rows.map((row: HranaValue[]) =>
            Object.fromEntries(row.map((value, i) => [result.cols[i].name, decodeValue(value)]))
        )
    );
}
