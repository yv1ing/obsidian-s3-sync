import { normalizeVaultPath } from "../core/util";

type GlobToken =
    | { type: "literal"; value: string }
    | { type: "star" }
    | { type: "any" }
    | { type: "anyDir" }
    | { type: "one" };

interface CompiledGlob {
    anchored: boolean;
    directory: boolean;
    tokens: GlobToken[];
}

function tokenize(source: string): GlobToken[] {
    const tokens: GlobToken[] = [];
    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        if (character === "*") {
            if (source[index + 1] === "*") {
                index++;
                if (source[index + 1] === "/") {
                    index++;
                    tokens.push({ type: "anyDir" });
                } else {
                    tokens.push({ type: "any" });
                }
            } else {
                tokens.push({ type: "star" });
            }
        } else if (character === "?") {
            tokens.push({ type: "one" });
        } else {
            tokens.push({ type: "literal", value: character });
        }
    }
    return tokens;
}

function compileGlob(pattern: string): CompiledGlob | null {
    let source = pattern.trim();
    if (!source) return null;
    let anchored = false;
    if (source.startsWith("/")) {
        anchored = true;
        source = source.replace(/^\/+/, "");
    }
    let directory = false;
    if (source.endsWith("/")) {
        directory = true;
        source = source.replace(/\/+$/, "");
    }
    if (!source) return null;
    return { anchored, directory, tokens: tokenize(source) };
}

function createMatcher(glob: CompiledGlob): (path: string) => boolean {
    let first = new Uint8Array(0);
    let second = new Uint8Array(0);

    return (path: string): boolean => {
        const length = path.length;
        if (first.length <= length) {
            first = new Uint8Array(length + 1);
            second = new Uint8Array(length + 1);
        }
        first.fill(0, 0, length + 1);
        second.fill(0, 0, length + 1);

        first[0] = 1;
        if (!glob.anchored) {
            for (let index = 0; index < length; index++) {
                if (path[index] === "/") first[index + 1] = 1;
            }
        }

        let reachable = first;
        let next = second;
        for (const token of glob.tokens) {
            next.fill(0, 0, length + 1);
            let hasNext = false;

            if (token.type === "literal") {
                const value = token.value;
                for (let index = 0; index < length; index++) {
                    if (reachable[index] && path[index] === value) {
                        next[index + 1] = 1;
                        hasNext = true;
                    }
                }
            } else if (token.type === "one") {
                for (let index = 0; index < length; index++) {
                    if (reachable[index] && path[index] !== "/") {
                        next[index + 1] = 1;
                        hasNext = true;
                    }
                }
            } else if (token.type === "star") {
                let minimum = Infinity;
                for (let index = 0; index <= length; index++) {
                    if (reachable[index] && index < minimum) minimum = index;
                    const atEnd = index === length;
                    const atSlash = !atEnd && path[index] === "/";
                    if (atSlash || atEnd) {
                        if (minimum !== Infinity) {
                            for (
                                let position = minimum;
                                position <= index;
                                position++
                            ) {
                                if (!next[position]) {
                                    next[position] = 1;
                                    hasNext = true;
                                }
                            }
                        }
                        minimum = Infinity;
                    }
                }
            } else if (token.type === "any") {
                let minimum = Infinity;
                for (let index = 0; index <= length; index++) {
                    if (reachable[index] && index < minimum) minimum = index;
                }
                if (minimum !== Infinity) {
                    for (let index = minimum; index <= length; index++) {
                        next[index] = 1;
                        hasNext = true;
                    }
                }
            } else {
                let minimum = Infinity;
                for (let index = 0; index <= length; index++) {
                    if (reachable[index]) {
                        next[index] = 1;
                        hasNext = true;
                        if (index < minimum) minimum = index;
                    }
                }
                if (minimum !== Infinity) {
                    for (let index = minimum + 1; index <= length; index++) {
                        if (path[index - 1] === "/") {
                            next[index] = 1;
                            hasNext = true;
                        }
                    }
                }
            }

            if (!hasNext) return false;
            [reachable, next] = [next, reachable];
        }

        if (!glob.directory) return reachable[length] === 1;
        for (let index = 0; index <= length; index++) {
            if (reachable[index] && (index === length || path[index] === "/")) {
                return true;
            }
        }
        return false;
    };
}

export function compileExcludes(
    patterns: readonly string[],
): (path: string) => boolean {
    const matchers = patterns
        .map((pattern) => compileGlob(pattern))
        .filter((glob): glob is CompiledGlob => glob !== null)
        .map((glob) => createMatcher(glob));
    return (path: string): boolean => {
        const normalized = normalizeVaultPath(path);
        return matchers.some((matcher) => matcher(normalized));
    };
}
