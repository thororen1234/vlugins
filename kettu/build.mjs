import swc from "@swc/core";
import { createHash } from "crypto";
import { build } from "esbuild";
import { existsSync } from "fs";
import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

const globals = {
    "react": "vendetta.metro.common.React",
    "react-native": "vendetta.metro.common.ReactNative"
};

const vendettaGlobals = {
    name: "vendetta-globals",
    setup(build) {
        build.onResolve({ filter: /^(@vendetta(\/.*)?|react|react-native)$/ }, args => ({ path: args.path, namespace: "vendetta-globals" }));
        build.onLoad({ filter: /.*/, namespace: "vendetta-globals" }, args => ({
            contents: `module.exports = ${globals[args.path] ?? args.path.slice(1).replaceAll("/", ".")};`,
            loader: "js"
        }));
    }
};

const hermes = {
    name: "hermes",
    setup(build) {
        build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
            const result = await swc.transformFile(args.path, {
                jsc: {
                    parser: args.path.endsWith("x")
                        ? { syntax: "typescript", tsx: true }
                        : { syntax: "typescript" },
                    transform: {
                        react: {
                            runtime: "classic",
                            pragma: "vendetta.metro.common.React.createElement",
                            pragmaFrag: "vendetta.metro.common.React.Fragment"
                        }
                    }
                },
                env: {
                    targets: "fully supports es6",
                    include: [
                        "transform-block-scoping",
                        "transform-classes",
                        "transform-async-to-generator",
                        "transform-async-generator-functions"
                    ],
                    exclude: [
                        "transform-parameters",
                        "transform-template-literals",
                        "transform-exponentiation-operator",
                        "transform-named-capturing-groups-regex",
                        "transform-nullish-coalescing-operator",
                        "transform-object-rest-spread",
                        "transform-optional-chaining",
                        "transform-logical-assignment-operators"
                    ]
                },
                module: { type: "es6" },
                sourceMaps: false
            });
            return { contents: result.code, loader: "js" };
        });
    }
};

const plugins = (await readdir(".", { withFileTypes: true }))
    .filter(d => d.isDirectory() && existsSync(join(d.name, "manifest.json")))
    .map(d => d.name);

for (const plugin of plugins) {
    const { outputFiles: [output] } = await build({
        entryPoints: [join(plugin, "index.tsx")],
        bundle: true,
        write: false,
        minify: true,
        format: "cjs",
        platform: "browser",
        outfile: "index.js",
        plugins: [vendettaGlobals, hermes],
        supported: {
            "const-and-let": false
        },
        legalComments: "none"
    });

    const js = `(()=>{var module={exports:{}},exports=module.exports;${output.text};return module.exports})()`;
    const manifest = JSON.parse(await readFile(join(plugin, "manifest.json"), "utf-8"));

    manifest.main = "index.js";
    manifest.hash = createHash("sha256").update(js).digest("hex");

    await mkdir(join("dist", plugin), { recursive: true });
    await writeFile(join("dist", plugin, "index.js"), js);
    await writeFile(join("dist", plugin, "manifest.json"), JSON.stringify(manifest));

    console.log(`Built ${plugin} (${(js.length / 1024).toFixed(1)} KiB)`);
}
