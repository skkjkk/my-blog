export interface LinkPart {
	text: string;
	url?: string;
}

export declare function linkify(content: string): LinkPart[];
export declare function formatRelative(iso: string, now?: number): string;
export declare function draftKey(slug: string): string;
