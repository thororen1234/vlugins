import { storage } from "@vendetta/plugin";
import { instead } from "@vendetta/patcher";
import { findByProps, findByStoreName } from "@vendetta/metro";
import { React, ReactNative as RN } from "@vendetta/metro/common";
import { showConfirmationAlert, showInputAlert } from "@vendetta/ui/alerts";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { Forms } from "@vendetta/ui/components";
import { showToast } from "@vendetta/ui/toasts";
import { semanticColors } from "@vendetta/ui";

import { type DbConfig } from "../../sponsorHelper/native/libsql";
import { importSponsorsCsv } from "../../sponsorHelper/native/parser";
import { type Context, verifyReceipt } from "../../sponsorHelper/native/receipt";
import { extractPdf } from "./pdf";

type Receipt = {
    filename: string;
    url: string;
    authorId?: string;
};

const getDbConfig = (): DbConfig => ({
    url: storage.dbUrl ?? "",
    username: storage.dbUsername ?? "",
    password: storage.dbPassword ?? ""
});

function toast(message: string, success = false) {
    showToast(message, getAssetIDByName(success ? "Check" : "Small"));
}

function parseDiscordMarkup(text: string) {
    const parser = findByProps("parse", "parseToAST", "reactParserFor");
    return parser?.parse?.(text, true, {
        allowHeading: true,
        allowLinks: true,
        allowList: true
    }) ?? text;
}

function getTextColor() {
    const theme = findByStoreName("ThemeStore")?.theme;
    const colors = findByProps("colors", "unsafe_rawColors");
    const resolver = colors?.internal ?? colors?.meta;
    return resolver?.resolveSemanticColor?.(theme, semanticColors.TEXT_DEFAULT) ?? "#dbdee1";
}

function getContentPdfs(content: string): Receipt[] {
    const urls = content.match(/https:\/\/cdn\.discord(?:app)?\.com\/attachments\/[^\s<>]*\.pdf(?:[?#][^\s<>]*)?/gi) ?? [];

    return urls.map(url => {
        const { pathname } = new URL(url);
        return {
            url,
            filename: pathname.slice(pathname.lastIndexOf("/") + 1)
        };
    });
}

function getMessageReceipts(message: any): Receipt[] {
    const attachments = Object.values(message.attachments ?? {})
        .filter((attachment: any) => /\.pdf(?:$|[?#])/i.test(attachment.filename ?? attachment.url ?? ""))
        .map((attachment: any) => ({
            url: attachment.url as string,
            filename: attachment.filename as string,
            authorId: message.author?.id as string | undefined
        }));

    return [...attachments, ...getContentPdfs(String(message.content ?? "")).map(receipt => ({
        ...receipt,
        authorId: message.author?.id as string | undefined
    }))];
}

function getReceipts(message: any): Receipt[] {
    const snapshotMessages = (message.message_snapshots ?? [])
        .map((snapshot: any) => snapshot.message)
        .filter(Boolean);

    return [message, ...snapshotMessages]
        .flatMap(getMessageReceipts)
        .filter((receipt, index, receipts) => receipts.findIndex(({ url }) => url === receipt.url) === index);
}

async function importCsvFromUrl(url: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not download CSV: ${response.status} ${response.statusText}`);

    return importSponsorsCsv(await response.text(), getDbConfig());
}

const getMessageLink = ({ channelId, messageId }) => `https://discord.com/channels/0/${channelId}/${messageId}`;

function openResult(result: Awaited<ReturnType<typeof verifyReceipt>>, ctx: Context) {
    const { date, ids, createdByPrawn, githubUsername, transactionId, data } = result;
    const warnings = [
        !createdByPrawn && "This receipt was not created by Prawn.",
        githubUsername.toLowerCase() !== data.username.toLowerCase()
        && `Receipt account ${githubUsername} does not match sponsor ${data.username}.`,
        ids.userId !== ctx.userId && `This GitHub account is associated with someone else: <@${ids.userId}>.`,
        ids.messageId !== ctx.messageId && `This receipt was already checked <t:${ids.checkedAt}:R>${ids.channelName && ` in #${ids.channelName}`}: ${getMessageLink(ids)}.`
    ].filter(Boolean);

    const rows = [
        ["GitHub", `[${data.username}](https://github.com/${data.username})`],
        ["Country", `${data.country.emoji} ${data.country.name}`],
        ["Total sponsorship", `$${(data.totalSponsorshipAmountInCents / 100).toFixed(2)}`],
        ["Receipt date", `<t:${Math.round(date.getTime() / 1000)}:R>`],
        ["First sponsorship", `<t:${Math.round(data.firstSponsorshipDate.getTime() / 1000)}:R>`],
        ["Transaction", transactionId]
    ];

    showConfirmationAlert({
        title: "Receipt Info",
        confirmText: "Close",
        cancelText: null,
        onConfirm: () => { },
        children: <RN.ScrollView style={{ maxHeight: RN.Dimensions.get("window").height * 0.7 }}>
            <RN.Text style={{ color: getTextColor() }}>{parseDiscordMarkup([...warnings, ...rows.map(([label, value]) => `${label}: ${value}`)].join("\n"))}</RN.Text>
        </RN.ScrollView>
    });
}

async function checkReceipt(receipt: Receipt, message: any) {
    const ctx: Context = {
        userId: String(receipt.authorId ?? message.author?.id ?? ""),
        channelId: String(message.channel_id ?? ""),
        channelName: "",
        messageId: String(message.id ?? "")
    };

    try {
        const url = new URL(receipt.url);
        if (!["cdn.discordapp.com", "cdn.discord.com"].includes(url.host) || !url.pathname.startsWith("/attachments/")) {
            throw new Error("The receipt must be a Discord CDN attachment");
        }

        const response = await fetch(receipt.url);
        if (!response.ok) throw new Error(`Could not download receipt: ${response.status} ${response.statusText}`);

        const { info, text } = extractPdf(new Uint8Array(await response.arrayBuffer()));
        openResult(await verifyReceipt(info, text, ctx, getDbConfig(), storage.githubToken ?? ""), ctx);
    } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
    }
}

function Settings() {
    const [, refresh] = React.useReducer((count: number) => count + 1, 0);
    const update = (key: string, value: string | { text: string; }) => {
        storage[key] = typeof value === "string" ? value : value.text;
        refresh();
    };

    const importFromUrl = () => showInputAlert({
        title: "Import sponsors CSV",
        initialValue: storage.csvUrl ?? "",
        placeholder: "https://example.com/sponsors.csv",
        confirmText: "Import",
        cancelText: "Cancel",
        onConfirm: async url => {
            storage.csvUrl = url;
            const count = await importCsvFromUrl(url);
            toast(`Imported ${count} transactions`, true);
        }
    });

    return <RN.ScrollView>
        <Forms.FormSection title="Database">
            <Forms.FormInput
                title="libSQL database URL"
                value={storage.dbUrl ?? ""}
                onChange={(value: string) => update("dbUrl", value)}
            />
            <Forms.FormInput
                title="Database username"
                value={storage.dbUsername ?? ""}
                onChange={(value: string) => update("dbUsername", value)}
            />
            <Forms.FormInput
                title="Database password"
                value={storage.dbPassword ?? ""}
                secureTextEntry
                onChange={(value: string) => update("dbPassword", value)}
            />
        </Forms.FormSection>
        <Forms.FormSection title="GitHub">
            <Forms.FormInput
                title="GitHub token (optional)"
                value={storage.githubToken ?? ""}
                secureTextEntry
                onChange={(value: string) => update("githubToken", value)}
            />
        </Forms.FormSection>
        <Forms.FormSection title="Sponsors">
            <Forms.FormRow
                label="Import sponsors CSV from URL"
                subLabel="Downloads the CSV and imports it into the configured database."
                onPress={importFromUrl}
            />
            <Forms.FormRow
                label="Check a receipt"
                subLabel="Quad-tap a message with a PDF receipt to check it."
            />
        </Forms.FormSection>
    </RN.ScrollView>;
}

const QUAD_TAP_WINDOW = 1500;

let unpatchDoubleTap: (() => void) | undefined;
let retryTimer: ReturnType<typeof setInterval> | undefined;
let pendingTap: { messageId: string; message: any; channel: any; at: number; } | undefined;

function enableDoubleTap() {
    const doubleTapReaction = findByProps("DoubleTapReactionEmoji")?.DoubleTapReactionEmoji;
    if (!doubleTapReaction?.updateSetting) return;

    const setting = doubleTapReaction.getSetting?.();
    doubleTapReaction.updateSetting({
        disableDoubleTap: false,
        emojiId: setting?.emojiId ?? null,
        emojiName: setting?.emojiName ?? null,
        animated: setting?.animated ?? null
    });
}

function onDoubleTap(message: any, channel: any) {
    const receipt = getReceipts(message)[0];
    if (!receipt) return false;

    const now = Date.now();
    const previousTap = pendingTap;
    if (previousTap && previousTap.messageId === message.id && now - previousTap.at <= QUAD_TAP_WINDOW) {
        pendingTap = undefined;
        toast("Checking sponsor receipt...", true);
        void checkReceipt(receipt, message);
        return true;
    }

    pendingTap = { messageId: message.id, message, channel, at: now };
    return true;
}

function tryPatchDoubleTap() {
    if (unpatchDoubleTap) return true;

    enableDoubleTap();
    const reactions = findByProps("handleAddDefaultDoubleTapReaction");
    if (typeof reactions?.handleAddDefaultDoubleTapReaction !== "function") return false;

    unpatchDoubleTap = instead("handleAddDefaultDoubleTapReaction", reactions, (args: any[], original: Function) => {
        if (onDoubleTap(args[0], args[1])) return;
        return original(...args);
    });
    return true;
}

function start() {
    if (unpatchDoubleTap || retryTimer) return;

    if (tryPatchDoubleTap()) return;
    retryTimer = setInterval(() => {
        if (!tryPatchDoubleTap()) return;
        clearInterval(retryTimer);
        retryTimer = undefined;
    }, 1000);
}

function stop() {
    if (retryTimer) clearInterval(retryTimer);
    retryTimer = undefined;
    unpatchDoubleTap?.();
    unpatchDoubleTap = undefined;
    pendingTap = undefined;
}

export default {
    start,
    stop,
    SettingsComponent: Settings,

    onLoad: start,
    onUnload: stop,
    settings: Settings
};
