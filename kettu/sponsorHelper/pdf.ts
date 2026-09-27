/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { inflateSync, unzlibSync } from "fflate";

type PdfValue = number | boolean | null | PdfName | PdfString | PdfRef | PdfOp | PdfValue[] | PdfDict;
interface PdfName { name: string; }
interface PdfString { str: string; }
interface PdfRef { ref: number; }
interface PdfOp { op: string; }
type PdfDict = Map<string, PdfValue>;
interface PdfStream { dict: PdfDict; data: string; }
interface Lexer { s: string; i: number; }

type Matrix = [number, number, number, number, number, number];
interface TextItem { x: number; endX: number; y: number; size: number; text: string; approx: boolean; order: number; }
interface FontDecoder { codeLength: number; toText(code: number): string; width(code: number): number | null; }

const WHITESPACE = "\0\t\n\f\r ";
const DELIMITERS = "()<>[]{}/%";
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const WIN_ANSI_HIGH = "€�‚ƒ„…†‡ˆ‰Š‹Œ�Ž��‘’“”•–—˜™š›œ�žŸ";

const isName = (v: PdfValue): v is PdfName => v != null && typeof v === "object" && "name" in v;
const isString = (v: PdfValue): v is PdfString => v != null && typeof v === "object" && "str" in v;
const isRef = (v: PdfValue): v is PdfRef => v != null && typeof v === "object" && "ref" in v;
const isOp = (v: PdfValue): v is PdfOp => v != null && typeof v === "object" && "op" in v;
const isDict = (v: unknown): v is PdfDict => v instanceof Map;

function bytesToLatin1(bytes: Uint8Array) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
    }
    return s;
}

function latin1ToBytes(s: string) {
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
    return bytes;
}

function multiply(a: Matrix, b: Matrix): Matrix {
    return [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5]
    ];
}

function skipWhitespace(lx: Lexer) {
    while (lx.i < lx.s.length) {
        const c = lx.s[lx.i];
        if (c === "%") {
            while (lx.i < lx.s.length && lx.s[lx.i] !== "\n" && lx.s[lx.i] !== "\r") lx.i++;
        } else if (WHITESPACE.includes(c)) {
            lx.i++;
        } else {
            break;
        }
    }
}

function readRegular(lx: Lexer) {
    const start = lx.i;
    while (lx.i < lx.s.length && !WHITESPACE.includes(lx.s[lx.i]) && !DELIMITERS.includes(lx.s[lx.i])) lx.i++;
    return lx.s.slice(start, lx.i);
}

function readLiteralString(lx: Lexer) {
    let depth = 1;
    let out = "";
    lx.i++;
    while (lx.i < lx.s.length) {
        const c = lx.s[lx.i++];
        if (c === "\\") {
            const e = lx.s[lx.i++];
            if (e === "n") out += "\n";
            else if (e === "r") out += "\r";
            else if (e === "t") out += "\t";
            else if (e === "b") out += "\b";
            else if (e === "f") out += "\f";
            else if (e === "\r") { if (lx.s[lx.i] === "\n") lx.i++; }
            else if (e === "\n") continue;
            else if (e >= "0" && e <= "7") {
                let oct = e;
                while (oct.length < 3 && lx.s[lx.i] >= "0" && lx.s[lx.i] <= "7") oct += lx.s[lx.i++];
                out += String.fromCharCode(parseInt(oct, 8) & 0xff);
            } else out += e;
        } else if (c === "(") {
            depth++;
            out += c;
        } else if (c === ")") {
            if (--depth === 0) break;
            out += c;
        } else {
            out += c;
        }
    }
    return out;
}

function readHexString(lx: Lexer) {
    const end = lx.s.indexOf(">", lx.i);
    let hex = lx.s.slice(lx.i + 1, end === -1 ? lx.s.length : end).replace(/[^0-9a-fA-F]/g, "");
    lx.i = end === -1 ? lx.s.length : end + 1;
    if (hex.length % 2) hex += "0";
    let out = "";
    for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    return out;
}

function readName(lx: Lexer) {
    lx.i++;
    return readRegular(lx).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function tryReadRef(lx: Lexer, num: number): PdfRef | null {
    const save = lx.i;
    skipWhitespace(lx);
    const gen = readRegular(lx);
    if (/^\d+$/.test(gen)) {
        skipWhitespace(lx);
        if (lx.s[lx.i] === "R" && (lx.i + 1 >= lx.s.length || WHITESPACE.includes(lx.s[lx.i + 1]) || DELIMITERS.includes(lx.s[lx.i + 1]))) {
            lx.i++;
            return { ref: num };
        }
    }
    lx.i = save;
    return null;
}

function readValue(lx: Lexer): PdfValue | undefined {
    skipWhitespace(lx);
    if (lx.i >= lx.s.length) return undefined;

    const c = lx.s[lx.i];
    if (c === "<" && lx.s[lx.i + 1] === "<") {
        lx.i += 2;
        const dict: PdfDict = new Map();
        for (;;) {
            skipWhitespace(lx);
            if (lx.i >= lx.s.length) break;
            if (lx.s[lx.i] === ">" && lx.s[lx.i + 1] === ">") {
                lx.i += 2;
                break;
            }
            const key = readValue(lx);
            const value = readValue(lx);
            if (key === undefined) break;
            if (isName(key) && value !== undefined) dict.set(key.name, value);
        }
        return dict;
    }
    if (c === "<") return { str: readHexString(lx) };
    if (c === "(") return { str: readLiteralString(lx) };
    if (c === "/") return { name: readName(lx) };
    if (c === "[") {
        lx.i++;
        const arr: PdfValue[] = [];
        for (;;) {
            skipWhitespace(lx);
            if (lx.i >= lx.s.length) break;
            if (lx.s[lx.i] === "]") {
                lx.i++;
                break;
            }
            const value = readValue(lx);
            if (value === undefined) break;
            arr.push(value);
        }
        return arr;
    }
    if (c === "]" || c === ")" || c === ">" || c === "{" || c === "}") {
        lx.i++;
        return { op: c };
    }

    const token = readRegular(lx);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(token)) {
        const num = parseFloat(token);
        return /^\d+$/.test(token) ? tryReadRef(lx, num) ?? num : num;
    }
    if (token === "true") return true;
    if (token === "false") return false;
    if (token === "null") return null;
    return { op: token };
}

function createDocument(bytes: Uint8Array) {
    const s = bytesToLatin1(bytes);
    const offsets = new Map<number, number>();
    const cache = new Map<number, PdfValue | PdfStream>();
    let trailer: PdfDict = new Map();

    function readXref() {
        let pos = parseInt(s.slice(s.lastIndexOf("startxref") + 9).trim(), 10);
        const seen = new Set<number>();

        while (Number.isFinite(pos) && !seen.has(pos)) {
            seen.add(pos);
            const lx: Lexer = { s, i: pos };
            skipWhitespace(lx);
            if (readRegular(lx) !== "xref") return false;

            for (;;) {
                skipWhitespace(lx);
                const first = readRegular(lx);
                if (first === "trailer") break;
                skipWhitespace(lx);
                const count = parseInt(readRegular(lx), 10);
                if (!/^\d+$/.test(first) || !Number.isFinite(count)) return false;

                for (let n = 0; n < count; n++) {
                    skipWhitespace(lx);
                    const offset = parseInt(readRegular(lx), 10);
                    skipWhitespace(lx);
                    readRegular(lx);
                    skipWhitespace(lx);
                    const type = readRegular(lx);
                    const num = parseInt(first, 10) + n;
                    if (type === "n" && !offsets.has(num)) offsets.set(num, offset);
                }
            }

            const dict = readValue(lx);
            if (!isDict(dict)) return false;
            for (const [key, value] of dict) if (!trailer.has(key)) trailer.set(key, value);

            const prev = dict.get("Prev");
            pos = typeof prev === "number" ? prev : NaN;
        }
        return offsets.size > 0;
    }

    function scanObjects() {
        const re = /(\d+)\s+\d+\s+obj\b/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(s))) offsets.set(parseInt(m[1], 10), m.index);

        const t = s.lastIndexOf("trailer");
        if (t !== -1) {
            const dict = readValue({ s, i: t + 7 });
            if (isDict(dict)) trailer = dict;
        }
        if (!trailer.has("Root")) {
            for (const num of offsets.keys()) {
                const obj = getObject(num);
                if (isDict(obj) && isName(obj.get("Type")!) && (obj.get("Type") as PdfName).name === "Catalog") {
                    trailer.set("Root", { ref: num });
                }
            }
        }
    }

    function getObject(num: number): PdfValue | PdfStream {
        if (cache.has(num)) return cache.get(num)!;
        cache.set(num, null);

        const offset = offsets.get(num);
        if (offset === undefined) return null;

        const lx: Lexer = { s, i: offset };
        for (let n = 0; n < 3; n++) {
            skipWhitespace(lx);
            readRegular(lx);
        }
        const value = readValue(lx) ?? null;

        skipWhitespace(lx);
        if (isDict(value) && s.startsWith("stream", lx.i)) {
            let start = lx.i + 6;
            if (s[start] === "\r") start++;
            if (s[start] === "\n") start++;

            const length = resolve(value.get("Length") ?? null);
            let end = typeof length === "number" ? start + length : -1;
            if (end < 0 || !/^\s*endstream/.test(s.slice(end, end + 32))) {
                end = s.indexOf("endstream", start);
                if (end === -1) end = s.length;
                if (s[end - 1] === "\n") end--;
                if (s[end - 1] === "\r") end--;
            }

            const stream: PdfStream = { dict: value, data: s.slice(start, end) };
            cache.set(num, stream);
            return stream;
        }

        cache.set(num, value);
        return value;
    }

    function resolve(value: PdfValue | undefined): PdfValue | PdfStream {
        let current: PdfValue | PdfStream = value ?? null;
        for (let depth = 0; depth < 16 && isRef(current as PdfValue); depth++) {
            current = getObject((current as PdfRef).ref);
        }
        return current;
    }

    function resolveDict(value: PdfValue | undefined): PdfDict | null {
        const resolved = resolve(value);
        if (isDict(resolved as PdfValue)) return resolved as PdfDict;
        if (resolved && typeof resolved === "object" && "dict" in resolved) return resolved.dict;
        return null;
    }

    function resolveStream(value: PdfValue | undefined): PdfStream | null {
        const resolved = resolve(value);
        return resolved && typeof resolved === "object" && "data" in resolved ? resolved : null;
    }

    if (!readXref()) scanObjects();

    return { trailer, getObject, resolve, resolveDict, resolveStream };
}

type PdfDocument = ReturnType<typeof createDocument>;

function decodeStream(stream: PdfStream) {
    const filter = stream.dict.get("Filter");
    const filters = (Array.isArray(filter) ? filter : filter ? [filter] : []).filter(isName).map(f => f.name);

    let data = stream.data;
    for (const name of filters) {
        if (name !== "FlateDecode" && name !== "Fl") return "";
        const bytes = latin1ToBytes(data);
        try {
            data = bytesToLatin1(unzlibSync(bytes));
        } catch {
            try {
                data = bytesToLatin1(inflateSync(bytes.subarray(2)));
            } catch {
                return "";
            }
        }
    }
    return data;
}

function decodeTextString(str: string) {
    if (str.startsWith("\xfe\xff")) {
        let out = "";
        for (let i = 2; i + 1 < str.length; i += 2) out += String.fromCharCode((str.charCodeAt(i) << 8) | str.charCodeAt(i + 1));
        return out;
    }
    if (str.startsWith("\xef\xbb\xbf")) return str.slice(3);
    return str;
}

function decodeUtf16Hex(hex: string) {
    let out = "";
    for (let i = 0; i + 3 < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return out;
}

function parseToUnicode(cmap: string) {
    const map = new Map<number, string>();

    const sections = /begin(bfchar|bfrange)([\s\S]*?)end\1/g;
    let section: RegExpExecArray | null;
    while ((section = sections.exec(cmap))) {
        const tokens = section[2].match(/<[0-9a-fA-F]*>|\[|\]/g) ?? [];
        const hex = (t: string) => t.slice(1, -1);

        if (section[1] === "bfchar") {
            for (let i = 0; i + 1 < tokens.length; i += 2) {
                map.set(parseInt(hex(tokens[i]), 16), decodeUtf16Hex(hex(tokens[i + 1])));
            }
            continue;
        }

        let i = 0;
        while (i + 2 < tokens.length) {
            const lo = parseInt(hex(tokens[i]), 16);
            const hi = parseInt(hex(tokens[i + 1]), 16);
            if (tokens[i + 2] === "[") {
                let j = i + 3;
                for (let code = lo; j < tokens.length && tokens[j] !== "]"; code++, j++) {
                    map.set(code, decodeUtf16Hex(hex(tokens[j])));
                }
                i = j + 1;
            } else {
                const dst = hex(tokens[i + 2]);
                const prefix = decodeUtf16Hex(dst.slice(0, -4));
                const last = parseInt(dst.slice(-4), 16);
                for (let code = lo; code <= hi && code - lo < 0x10000; code++) {
                    map.set(code, prefix + String.fromCharCode(last + code - lo));
                }
                i += 3;
            }
        }
    }

    return map;
}

function createWidthLookup(doc: PdfDocument, font: PdfDict | null, isType0: boolean): (code: number) => number | null {
    if (!font) return () => null;

    if (isType0) {
        const descendants = doc.resolve(font.get("DescendantFonts"));
        const cidFont = Array.isArray(descendants) ? doc.resolveDict(descendants[0]) : null;
        if (!cidFont) return () => null;

        const dw = doc.resolve(cidFont.get("DW"));
        const defaultWidth = typeof dw === "number" ? dw : 1000;
        const widths = new Map<number, number>();
        const w = doc.resolve(cidFont.get("W"));

        if (Array.isArray(w)) {
            let i = 0;
            while (i + 1 < w.length) {
                const first = w[i];
                const second = w[i + 1];
                if (typeof first !== "number") break;
                if (Array.isArray(second)) {
                    second.forEach((v, j) => typeof v === "number" && widths.set(first + j, v));
                    i += 2;
                } else if (typeof second === "number" && typeof w[i + 2] === "number") {
                    for (let c = first; c <= second && c - first < 0x10000; c++) widths.set(c, w[i + 2] as number);
                    i += 3;
                } else {
                    break;
                }
            }
        }

        return code => widths.get(code) ?? defaultWidth;
    }

    const firstChar = doc.resolve(font.get("FirstChar"));
    const widths = doc.resolve(font.get("Widths"));
    if (typeof firstChar !== "number" || !Array.isArray(widths)) return () => null;

    const descriptor = doc.resolveDict(font.get("FontDescriptor"));
    const missing = descriptor && doc.resolve(descriptor.get("MissingWidth"));
    const missingWidth = typeof missing === "number" ? missing : 0;

    return code => {
        const width = widths[code - firstChar];
        return typeof width === "number" ? width : missingWidth;
    };
}

function createFontDecoder(doc: PdfDocument, font: PdfDict | null): FontDecoder {
    const subtype = font?.get("Subtype");
    const isType0 = subtype != null && isName(subtype) && subtype.name === "Type0";
    const toUnicode = font && doc.resolveStream(font.get("ToUnicode"));
    const map = toUnicode ? parseToUnicode(decodeStream(toUnicode)) : null;

    return {
        codeLength: isType0 ? 2 : 1,
        toText(code) {
            const mapped = map?.get(code);
            if (mapped !== undefined) return mapped;
            if (!isType0 && code >= 0x80 && code <= 0x9f) return WIN_ANSI_HIGH[code - 0x80];
            return String.fromCharCode(code);
        },
        width: createWidthLookup(doc, font, isType0)
    };
}

function extractPageItems(doc: PdfDocument, content: string, resources: PdfDict | null, baseCtm: Matrix, items: TextItem[], depth: number) {
    const fonts = new Map<string, FontDecoder>();
    const fontDict = resources && doc.resolveDict(resources.get("Font"));
    const xObjects = resources && doc.resolveDict(resources.get("XObject"));

    const getFont = (name: string) => {
        if (!fonts.has(name)) fonts.set(name, createFontDecoder(doc, fontDict && doc.resolveDict(fontDict.get(name))));
        return fonts.get(name)!;
    };

    let ctm = baseCtm;
    const ctmStack: Matrix[] = [];
    let tm: Matrix = IDENTITY;
    let tlm: Matrix = IDENTITY;
    let font = createFontDecoder(doc, null);
    let fontSize = 0;
    let leading = 0;
    let charSpacing = 0;
    let wordSpacing = 0;
    let horizontalScale = 1;
    let moved = true;
    let last: TextItem | null = null;

    const moveText = (tx: number, ty: number) => {
        tlm = multiply([1, 0, 0, 1, tx, ty], tlm);
        tm = tlm;
        moved = true;
    };

    const advance = (tx: number) => {
        tm = multiply([1, 0, 0, 1, tx, 0], tm);
    };

    const showBytes = (bytes: string) => {
        let text = "";
        let approx = false;
        const len = font.codeLength;

        for (let i = 0; i + len <= bytes.length; i += len) {
            let code = 0;
            for (let j = 0; j < len; j++) code = (code << 8) | bytes.charCodeAt(i + j);

            text += font.toText(code);
            const width = font.width(code);
            if (width === null) approx = true;
            advance(((width ?? 500) / 1000 * fontSize + charSpacing + (len === 1 && code === 32 ? wordSpacing : 0)) * horizontalScale);
        }

        return { text, approx };
    };

    const startShow = () => {
        const m = multiply(tm, ctm);
        return { x: m[4], y: m[5], size: Math.abs(fontSize * m[3]) || Math.abs(fontSize) || 1 };
    };

    const finishShow = (start: { x: number; y: number; size: number; }, text: string, approx: boolean) => {
        if (!text) return;
        const endX = multiply(tm, ctm)[4];

        if (!moved && last) {
            last.text += text;
            last.endX = endX;
            last.approx = last.approx || approx;
            return;
        }

        last = { ...start, endX, text, approx, order: items.length };
        items.push(last);
        moved = false;
    };

    const show = (bytes: string) => {
        const start = startShow();
        const { text, approx } = showBytes(bytes);
        finishShow(start, text, approx);
    };

    const lx: Lexer = { s: content, i: 0 };
    let operands: PdfValue[] = [];

    for (;;) {
        const token = readValue(lx);
        if (token === undefined) break;
        if (!isOp(token)) {
            operands.push(token);
            continue;
        }

        const args = operands;
        operands = [];
        const num = (i: number) => (typeof args[i] === "number" ? args[i] as number : 0);

        switch (token.op) {
            case "q": ctmStack.push(ctm); break;
            case "Q": ctm = ctmStack.pop() ?? baseCtm; moved = true; break;
            case "cm": ctm = multiply([num(0), num(1), num(2), num(3), num(4), num(5)], ctm); moved = true; break;
            case "BT": tm = tlm = IDENTITY; moved = true; break;
            case "Tf": {
                const name = args[0];
                if (isName(name)) font = getFont(name.name);
                fontSize = num(1);
                break;
            }
            case "TL": leading = num(0); break;
            case "Tc": charSpacing = num(0); break;
            case "Tw": wordSpacing = num(0); break;
            case "Tz": horizontalScale = num(0) / 100; break;
            case "Td": moveText(num(0), num(1)); break;
            case "TD": leading = -num(1); moveText(num(0), num(1)); break;
            case "Tm": tm = tlm = [num(0), num(1), num(2), num(3), num(4), num(5)]; moved = true; break;
            case "T*": moveText(0, -leading); break;
            case "Tj": {
                const str = args[0];
                if (isString(str)) show(str.str);
                break;
            }
            case "'":
            case "\"": {
                if (token.op === "\"") {
                    wordSpacing = num(0);
                    charSpacing = num(1);
                }
                moveText(0, -leading);
                const str = args[args.length - 1];
                if (isString(str)) show(str.str);
                break;
            }
            case "TJ": {
                const arr = args[0];
                if (!Array.isArray(arr)) break;
                const start = startShow();
                let text = "";
                let approx = false;
                for (const part of arr) {
                    if (isString(part)) {
                        const shown = showBytes(part.str);
                        text += shown.text;
                        approx = approx || shown.approx;
                    } else if (typeof part === "number") {
                        advance(-part / 1000 * fontSize * horizontalScale);
                        if (part < -250) text += " ";
                    }
                }
                finishShow(start, text, approx);
                break;
            }
            case "Do": {
                const name = args[0];
                if (!isName(name) || !xObjects || depth > 8) break;
                const form = doc.resolveStream(xObjects.get(name.name));
                const subtype = form?.dict.get("Subtype");
                if (!form || !isName(subtype!) || subtype.name !== "Form") break;

                const matrix = form.dict.get("Matrix");
                const formMatrix = Array.isArray(matrix) && matrix.length === 6 ? matrix.map(v => (typeof v === "number" ? v : 0)) as Matrix : IDENTITY;
                const formResources = doc.resolveDict(form.dict.get("Resources")) ?? resources;
                extractPageItems(doc, decodeStream(form), formResources, multiply(formMatrix, ctm), items, depth + 1);
                moved = true;
                break;
            }
            case "BI": {
                const id = content.indexOf("ID", lx.i);
                const ei = id === -1 ? -1 : content.slice(id + 3).search(/\sEI(\s|$)/);
                lx.i = ei === -1 ? content.length : id + 3 + ei + 3;
                break;
            }
        }
    }
}

function layoutItems(items: TextItem[]) {
    const sorted = [...items].sort((a, b) => b.y - a.y || a.order - b.order);
    const lines: TextItem[][] = [];

    for (const item of sorted) {
        const line = lines[lines.length - 1];
        if (line && Math.abs(line[0].y - item.y) <= Math.max(line[0].size, item.size) * 0.5) line.push(item);
        else lines.push([item]);
    }

    return lines
        .map(line => {
            const parts = line.sort((a, b) => a.x - b.x || a.order - b.order).filter(item => item.text.trim());
            return parts.reduce((out, item, i) => {
                if (i === 0) return item.text;
                const prev = parts[i - 1];
                const gap = item.x - prev.endX;
                const separated = prev.approx || item.approx || gap > Math.min(prev.size, item.size) * 0.15;
                return out + (separated ? " " : "") + item.text;
            }, "").trim();
        })
        .filter(Boolean)
        .join("\n");
}

function collectPages(doc: PdfDocument, node: PdfDict | null, inheritedResources: PdfDict | null, pages: { page: PdfDict; resources: PdfDict | null; }[], seen: Set<PdfDict>) {
    if (!node || seen.has(node)) return;
    seen.add(node);

    const resources = doc.resolveDict(node.get("Resources")) ?? inheritedResources;
    const kids = doc.resolve(node.get("Kids"));

    if (Array.isArray(kids)) {
        for (const kid of kids) collectPages(doc, doc.resolveDict(kid), resources, pages, seen);
    } else {
        pages.push({ page: node, resources });
    }
}

export function extractPdf(bytes: Uint8Array) {
    const doc = createDocument(bytes);

    const infoDict = doc.resolveDict(doc.trailer.get("Info"));
    const info = infoDict
        ? [...infoDict].filter(([, v]) => isString(v)).map(([k, v]) => `${k}: ${decodeTextString((v as PdfString).str)}`).join("\n")
        : "";

    const root = doc.resolveDict(doc.trailer.get("Root"));
    const pages: { page: PdfDict; resources: PdfDict | null; }[] = [];
    collectPages(doc, root && doc.resolveDict(root.get("Pages")), null, pages, new Set());

    const pageTexts = pages.map(({ page, resources }) => {
        const contents = doc.resolve(page.get("Contents"));
        const streams = (Array.isArray(contents) ? contents : [contents])
            .map(c => (c && typeof c === "object" && "data" in c ? c : doc.resolveStream(c as PdfValue)))
            .filter((c): c is PdfStream => c != null);

        const items: TextItem[] = [];
        extractPageItems(doc, streams.map(decodeStream).join("\n"), resources, IDENTITY, items, 0);
        return layoutItems(items);
    });

    return { info, text: pageTexts.join("\n\n") };
}
