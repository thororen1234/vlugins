/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { definePluginSettings } from "@api/Settings";
import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import { Card } from "@components/Card";
import { Flex } from "@components/Flex";
import { Link } from "@components/Link";
import { Margins } from "@components/margins";
import { Paragraph } from "@components/Paragraph";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { chooseFile } from "@utils/web";
import { Message, MessageAttachment } from "@vencord/discord-types";
import { ChannelStore, Menu, Modal, openModalLazy, Parser, React, showToast, Toasts } from "@webpack/common";

import type { Context } from "./native";

const Native = VencordNative.pluginHelpers.SponsorHelper as PluginNative<typeof import("./native")>;

type Receipt = Pick<MessageAttachment, "id" | "filename" | "url">;

const settings = definePluginSettings({
    dbUrl: {
        type: OptionType.STRING,
        description: "libSQL database URL",
        default: ""
    },
    dbUsername: {
        type: OptionType.STRING,
        description: "Database username",
        default: ""
    },
    dbPassword: {
        type: OptionType.STRING,
        description: "Database password",
        default: ""
    },
    githubToken: {
        type: OptionType.STRING,
        description: "GitHub token used to look up sponsor accounts",
        default: ""
    },
    importCsv: {
        type: OptionType.COMPONENT,
        component: ImportCsvButton
    }
});

const getDbConfig = () => ({
    url: settings.store.dbUrl,
    username: settings.store.dbUsername,
    password: settings.store.dbPassword
});

function ImportCsvButton() {
    const [importing, setImporting] = React.useState(false);

    async function importCsv() {
        const file = await chooseFile(".csv,text/csv");
        if (!file) return;

        setImporting(true);
        try {
            const count = await Native.importCsv(await file.text(), getDbConfig());
            showToast(`Imported ${count} transactions`, Toasts.Type.SUCCESS);
        } catch (e) {
            showToast(String(e), Toasts.Type.FAILURE);
        } finally {
            setImporting(false);
        }
    }

    return (
        <Button onClick={importCsv} disabled={importing}>
            {importing ? "Importing..." : "Import Sponsors CSV"}
        </Button>
    );
}

const getMessageLink = ({ channelId, messageId }) => `https://discord.com/channels/0/${channelId}/${messageId}`;

function getContentPdfs(content: string): Receipt[] {
    const urls = content.match(/https:\/\/cdn\.discordapp\.com\/attachments\/[^\s<>]*\.pdf(?:[?#][^\s<>]*)?/gi) ?? [] as string[];

    return urls.map(url => {
        const { pathname } = new URL(url);
        return {
            id: url,
            url,
            filename: pathname.slice(pathname.lastIndexOf("/") + 1)
        };
    });
}

function checkReceipt(ctx: Context, pdf: Receipt) {
    const { userId, messageId } = ctx;
    openModalLazy(async () => {
        const result = await Native.checkReceipt(pdf.url, ctx, getDbConfig(), settings.store.githubToken)
            .catch(e => {
                showToast(String(e), Toasts.Type.FAILURE);
            });

        if (!result) return modalProps => (modalProps.onClose(), null);

        const { date, ids, createdByPrawn, githubUsername, data: { country, firstSponsorshipDate, totalSponsorshipAmountInCents, username } } = result;

        const cards = [
            !createdByPrawn && <Card variant="warning">Receipt not created by Prawn</Card>,

            ids.messageId !== messageId && (
                <Card variant="warning">
                    Receipt already checked {Parser.parse(`<t:${ids.checkedAt}:R>`)}{ids.channelName && ` in #${ids.channelName}`}: {Parser.parse(getMessageLink(ids))}
                </Card>
            ),

            ids.userId !== userId && (
                <Card variant="warning">
                    This GitHub user is associated with someone else: {Parser.parse(`<@${ids.userId}>`)}
                </Card>
            ),

            githubUsername !== username && (
                <Card variant="warning">
                    <Flex flexDirection="column" gap="8px">
                        <BaseText size="md" weight="semibold">Mismatched GitHub username</BaseText>
                        <span>&ndash; Expected: <Link href={`https://github.com/${githubUsername}`}>{githubUsername}</Link></span>
                        <span>&ndash; Actual: <Link href={`https://github.com/${username}`}>{username}</Link></span>
                    </Flex>
                </Card>
            )
        ].filter(Boolean);

        const textRows = [
            ["User", <>
                <img alt="" src={`https://github.com/${username}.png?size=32`} style={{ width: "1lh", height: "1lh", borderRadius: "50%" }} />
                <Link href={`https://github.com/${username}`}>{username}</Link>
                <>({country.emoji} {country.name})</>
            </>],
            ["Total Amount", `$${(totalSponsorshipAmountInCents / 100).toFixed(2)}`],
            ["Date", Parser.parse(`<t:${Math.round(date.getTime() / 1000)}:R>`)],
            ["First Date", Parser.parse(`<t:${Math.round(firstSponsorshipDate.getTime() / 1000)}:R>`)],
        ] as [string, React.ReactNode][];

        return modalProps => (
            <Modal
                {...modalProps}
                title="Receipt Info"
            >
                {!!cards.length && <Flex flexDirection="column" gap="8px" className={Margins.bottom20}>{cards}</Flex>}

                <div className="vc-sponsorHelper-info">
                    {textRows.map(([label, value]) => (
                        <React.Fragment key={label}>
                            <Paragraph><strong>{label}:</strong></Paragraph>
                            <Paragraph><Flex alignItems="center" gap="6px">{value}</Flex></Paragraph>
                        </React.Fragment>
                    ))}
                </div>
            </Modal>
        );
    });
}

export default definePlugin({
    name: "SponsorHelper",
    authors: [Devs.Ven],
    description: "You don't need this",
    settings,

    contextMenus: {
        message(children, { message: msg }: { message: Message; }) {
            const channel = ChannelStore.getChannel(msg.channel_id);
            if (!channel) return;

            const ctx: Context = {
                userId: msg.author.id,
                channelId: msg.channel_id,
                channelName: channel.name,
                messageId: msg.id
            };

            if (msg.messageSnapshots.length) msg = msg.messageSnapshots[0].message;

            const pdfs = [
                ...msg.attachments.filter(a => a.filename.endsWith(".pdf")),
                ...getContentPdfs(msg.content)
            ].filter((pdf, index, receipts) => receipts.findIndex(receipt => receipt.url === pdf.url) === index);
            if (!pdfs.length) return;

            if (pdfs.length === 1) {
                children.push(
                    <Menu.MenuItem
                        id="vc-check-receipt"
                        label="Check Receipt"
                        action={() => checkReceipt(ctx, pdfs[0])}
                    />
                );
            } else {
                children.push(
                    <Menu.MenuItem
                        id="vc-check-receipt"
                        label="Check Receipt"
                    >
                        {pdfs.map(pdf => (
                            <Menu.MenuItem
                                key={pdf.id}
                                id={`vc-check-receipt-${pdf.id}`}
                                label={pdf.filename}
                                action={() => checkReceipt(ctx, pdf)}
                            />
                        ))}
                    </Menu.MenuItem>
                );
            }
        }
    }
});
