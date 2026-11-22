const OSC = "\x1B]633;";
const BEL = "\x07";

function escape(value: string): string {
	return value.replaceAll(/[\\;\x00-\x20]/gu, (char) => (char === "\\" ? "\\\\" : `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`));
}

export const promptStart = (): string => `${OSC}A${BEL}`;

export const commandStart = (): string => `${OSC}B${BEL}`;

export const commandLine = (line: string): string => `${OSC}E;${escape(line)}${BEL}`;

export const commandExecuted = (): string => `${OSC}C${BEL}`;

export const commandFinished = (exitCode?: number): string => `${OSC}D${exitCode === undefined ? "" : ";" + exitCode}${BEL}`;

export const workingDirectory = (cwd: string): string => `${OSC}P;Cwd=${escape(cwd)}${BEL}`;
