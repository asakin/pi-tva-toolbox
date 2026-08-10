/**
 * Display a /pluck pattern as /…/i without breaking when the pattern contains `/`.
 */
export function formatPattern(regexStr: string): string {
	return `/${regexStr.replace(/\//g, "\\/")}/i`;
}
