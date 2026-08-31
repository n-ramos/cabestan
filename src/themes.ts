export interface TermTheme {
  id: string;
  label: string;
  colors: Record<string, string>;
}

const CABESTAN = {
  background: "#0a1118",
  foreground: "#dce6ee",
  cursor: "#d9a441",
  cursorAccent: "#0a1118",
  selectionBackground: "#2a3f52",
  black: "#17222d",
  red: "#e06c5a",
  green: "#63b3a1",
  yellow: "#d9a441",
  blue: "#7099c7",
  magenta: "#b58ac9",
  cyan: "#6bc1ce",
  white: "#c3d0da",
  brightBlack: "#4d6070",
  brightRed: "#f08a78",
  brightGreen: "#82cfbd",
  brightYellow: "#efc067",
  brightBlue: "#93b7e0",
  brightMagenta: "#cfa8e0",
  brightCyan: "#8fdbe6",
  brightWhite: "#eef4f8",
};

export const TERM_THEMES: TermTheme[] = [
  { id: "cabestan", label: "Cabestan", colors: CABESTAN },
  {
    id: "nuit",
    label: "Nuit profonde",
    colors: {
      ...CABESTAN,
      background: "#05080b",
      foreground: "#c9d6e2",
      selectionBackground: "#1d2b3a",
    },
  },
  {
    id: "ardoise",
    label: "Ardoise",
    colors: {
      ...CABESTAN,
      background: "#1c1f24",
      foreground: "#d7dce2",
      cursor: "#8fbcbb",
      selectionBackground: "#333a44",
      blue: "#81a1c1",
      cyan: "#8fbcbb",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      red: "#bf616a",
      magenta: "#b48ead",
    },
  },
  {
    id: "papier",
    label: "Papier (clair)",
    colors: {
      background: "#f6f4ee",
      foreground: "#2c333a",
      cursor: "#b07d20",
      cursorAccent: "#f6f4ee",
      selectionBackground: "#dcd8cc",
      black: "#2c333a",
      red: "#b3402f",
      green: "#3d7a68",
      yellow: "#a5761c",
      blue: "#3b5f89",
      magenta: "#7e558f",
      cyan: "#2f7d88",
      white: "#5a6572",
      brightBlack: "#7b8794",
      brightRed: "#c9533f",
      brightGreen: "#4e947f",
      brightYellow: "#c08c26",
      brightBlue: "#4b74a3",
      brightMagenta: "#946aa6",
      brightCyan: "#3d95a1",
      brightWhite: "#2c333a",
    },
  },
];

export const themeById = (id: string) =>
  TERM_THEMES.find((t) => t.id === id) ?? TERM_THEMES[0];
