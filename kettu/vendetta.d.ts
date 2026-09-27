declare namespace JSX {
    interface IntrinsicElements {
        [elementName: string]: any;
    }
}

declare module "@vendetta/plugin" {
    export const storage: Record<string, any>;
}

declare module "@vendetta/patcher" {
    export const after: any;
    export const before: any;
    export const instead: any;
}

declare module "@vendetta/metro" {
    export const findByName: any;
    export const findByProps: any;
    export const findByStoreName: any;
}

declare module "@vendetta/metro/common" {
    export const React: any;
    export const ReactNative: any;
}

declare module "@vendetta/ui/components" {
    export const Forms: any;
}

declare module "@vendetta/ui" {
    export const semanticColors: any;
}

declare module "@vendetta/ui/alerts" {
    export const showInputAlert: any;
    export const showConfirmationAlert: any;
}

declare module "@vendetta/ui/assets" {
    export const getAssetIDByName: any;
}

declare module "@vendetta/ui/toasts" {
    export const showToast: any;
}
