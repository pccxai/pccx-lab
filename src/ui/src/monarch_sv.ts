// ─── Monarch SystemVerilog tokenizer ─────────────────────────────────────────
// Distilled from IEEE 1800-2017 Annex B (reserved keywords) and
// tree-sitter-verilog/grammar.js. Monarch is a DFA (no WASM), registered
// via monaco.languages.setMonarchTokensProvider in CodeEditor.tsx.
//
// Reference:
//   https://microsoft.github.io/monaco-editor/monarch.html
//   https://standards.ieee.org/ieee/1800/7743/
//   https://github.com/tree-sitter/tree-sitter-verilog
//
// Note: `languages.IMonarchLanguage` is duck-typed as a plain object literal
// here so consumers don't need to import the monaco-editor type surface.

export const monarchSv: any = {
    defaultToken: "",
    tokenPostfix: ".sv",

    // IEEE 1800-2017 §B — reserved keywords. Conservative cut focused on
    // tokens pccx-lab's UVM templates actually exercise + common RTL.
    keywords: [
        "accept_on", "alias", "always", "always_comb", "always_ff",
        "always_latch", "and", "assert", "assign", "assume", "automatic",
        "before", "begin", "bind", "bins", "binsof", "bit", "break",
        "buf", "bufif0", "bufif1", "byte", "case", "casex", "casez",
        "cell", "chandle", "checker", "class", "clocking", "cmos",
        "config", "const", "constraint", "context", "continue", "cover",
        "covergroup", "coverpoint", "cross", "deassign", "default",
        "defparam", "design", "disable", "dist", "do", "edge", "else",
        "end", "endcase", "endchecker", "endclass", "endclocking",
        "endconfig", "endfunction", "endgenerate", "endgroup",
        "endinterface", "endmodule", "endpackage", "endprimitive",
        "endprogram", "endproperty", "endspecify", "endsequence",
        "endtable", "endtask", "enum", "event", "eventually", "expect",
        "export", "extends", "extern", "final", "first_match", "for",
        "force", "foreach", "forever", "fork", "forkjoin", "function",
        "generate", "genvar", "global", "highz0", "highz1", "if", "iff",
        "ifnone", "ignore_bins", "illegal_bins", "implements", "implies",
        "import", "incdir", "include", "initial", "inout", "input",
        "inside", "instance", "int", "integer", "interconnect",
        "interface", "intersect", "join", "join_any", "join_none",
        "large", "let", "liblist", "library", "local", "localparam",
        "logic", "longint", "macromodule", "matches", "medium",
        "modport", "module", "nand", "negedge", "nettype", "new",
        "nexttime", "nmos", "nor", "noshowcancelled", "not", "notif0",
        "notif1", "null", "or", "output", "package", "packed",
        "parameter", "pmos", "posedge", "primitive", "priority",
        "program", "property", "protected", "pull0", "pull1",
        "pulldown", "pullup", "pulsestyle_ondetect", "pulsestyle_onevent",
        "pure", "rand", "randc", "randcase", "randsequence", "rcmos",
        "real", "realtime", "ref", "reg", "reject_on", "release",
        "repeat", "restrict", "return", "rnmos", "rpmos", "rtran",
        "rtranif0", "rtranif1", "s_always", "s_eventually", "s_nexttime",
        "s_until", "s_until_with", "scalared", "sequence", "shortint",
        "shortreal", "showcancelled", "signed", "small", "soft", "solve",
        "specify", "specparam", "static", "string", "strong", "strong0",
        "strong1", "struct", "super", "supply0", "supply1", "sync_accept_on",
        "sync_reject_on", "table", "tagged", "task", "this", "throughout",
        "time", "timeprecision", "timeunit", "tran", "tranif0", "tranif1",
        "tri", "tri0", "tri1", "triand", "trior", "trireg", "type",
        "typedef", "union", "unique", "unique0", "unsigned", "until",
        "until_with", "untyped", "use", "uwire", "var", "vectored",
        "virtual", "void", "wait", "wait_order", "wand", "weak",
        "weak0", "weak1", "while", "wildcard", "wire", "with", "within",
        "wor", "xnor", "xor",
    ],

    // UVM macro-class identifiers — highlighted as "type" so they stand out
    // against plain keywords.
    typeKeywords: [
        "uvm_component", "uvm_driver", "uvm_monitor", "uvm_env",
        "uvm_scoreboard", "uvm_sequence", "uvm_sequencer", "uvm_phase",
        "uvm_analysis_port", "uvm_analysis_imp", "uvm_object",
        "uvm_test", "uvm_agent", "uvm_config_db", "uvm_info", "uvm_fatal",
        "uvm_error", "uvm_warning",
    ],

    // System tasks — $display, $finish, $time, $dumpvars, $monitor, …
    systemTasks: /\$[a-zA-Z_][a-zA-Z0-9_]*/,

    // Compiler directives — `include, `define, `timescale, `ifdef …
    directiveKeywords: [
        "include", "define", "undef", "ifdef", "ifndef", "else",
        "elsif", "endif", "timescale", "resetall", "default_nettype",
        "line", "pragma", "begin_keywords", "end_keywords",
        "unconnected_drive", "nounconnected_drive", "celldefine",
        "endcelldefine",
    ],

    operators: [
        "=", ">", "<", "!", "~", "?", ":", "==", "<=", ">=", "!=",
        "&&", "||", "++", "--", "+", "-", "*", "/", "&", "|", "^",
        "%", "<<", ">>", "<<<", ">>>", "===", "!==", "==?", "!=?",
        "->", "->>", "&&&", "|->", "|=>", "##",
    ],

    // Matcher hooks (borrowed verbatim from the Monaco TypeScript sample).
    symbols: /[=><!~?:&|+\-*/^%]+/,
    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,

    // Top-level tokenizer ruleset. Monarch processes first-match-wins
    // per line; order matters.
    tokenizer: {
        root: [
            // Identifiers vs keywords vs UVM type-keywords. `@cases` resolves
            // a captured word against multiple tables in priority order.
            [/[a-zA-Z_][\w$]*/, {
                cases: {
                    "@typeKeywords": "type",
                    "@keywords": "keyword",
                    "@default": "identifier",
                },
            }],

            // Whitespace + comments.
            { include: "@whitespace" },

            // Compiler directives — `include, `timescale, `ifdef …
            [/`[a-zA-Z_]\w*/, {
                cases: {
                    "@directiveKeywords": { token: "keyword.directive" },
                    "@default": "annotation",
                },
            }],

            // System tasks — $display, $finish, $time.
            [/\$[a-zA-Z_]\w*/, "predefined"],

            // Brackets and delimiters.
            [/[{}()\[\]]/, "@brackets"],
            [/[<>](?!@symbols)/, "@brackets"],
            [/@symbols/, {
                cases: {
                    "@operators": "operator",
                    "@default": "",
                },
            }],

            // Numeric literals — SystemVerilog sized numbers (32'd42, 'h3a,
            // 'b0101), decimals, real/BF16-looking floats.
            [/\d+'[sS]?[bB][01xzXZ_?]+/, "number.binary"],
            [/\d+'[sS]?[oO][0-7xzXZ_?]+/, "number.octal"],
            [/\d+'[sS]?[dD][0-9xzXZ_?]+/, "number"],
            [/\d+'[sS]?[hH][0-9a-fA-FxzXZ_?]+/, "number.hex"],
            [/'[sS]?[bB][01xzXZ_?]+/, "number.binary"],
            [/'[sS]?[oO][0-7xzXZ_?]+/, "number.octal"],
            [/'[sS]?[dD][0-9xzXZ_?]+/, "number"],
            [/'[sS]?[hH][0-9a-fA-FxzXZ_?]+/, "number.hex"],
            [/\d*\.\d+([eE][+-]?\d+)?[fF]?/, "number.float"],
            [/\d+[eE][+-]?\d+[fF]?/, "number.float"],
            [/\d[\d_]*/, "number"],

            // Strings.
            [/"([^"\\]|\\.)*$/, "string.invalid"],
            [/"/, { token: "string.quote", bracket: "@open", next: "@string" }],

            // Stray punctuation.
            [/[;,.]/, "delimiter"],
        ],

        comment: [
            [/[^/*]+/, "comment"],
            [/\*\//, "comment", "@pop"],
            [/[/*]/, "comment"],
        ],

        string: [
            [/[^\\"]+/, "string"],
            [/@escapes/, "string.escape"],
            [/\\./, "string.escape.invalid"],
            [/"/, { token: "string.quote", bracket: "@close", next: "@pop" }],
        ],

        whitespace: [
            [/[ \t\r\n]+/, "white"],
            [/\/\*/, "comment", "@comment"],
            [/\/\/.*$/, "comment"],
        ],
    },
};

// Monarch language configuration — brackets for matching, comment markers
// for Ctrl+/ toggle.
export const systemverilogLanguageConfig: any = {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [
        ["{", "}"], ["[", "]"], ["(", ")"],
        ["begin", "end"], ["module", "endmodule"], ["class", "endclass"],
        ["function", "endfunction"], ["task", "endtask"],
        ["interface", "endinterface"], ["case", "endcase"],
        ["clocking", "endclocking"],
    ],
    autoClosingPairs: [
        { open: "{", close: "}" },
        { open: "[", close: "]" },
        { open: "(", close: ")" },
        { open: "\"", close: "\"" },
        { open: "'", close: "'" },
    ],
    surroundingPairs: [
        { open: "{", close: "}" },
        { open: "[", close: "]" },
        { open: "(", close: ")" },
        { open: "\"", close: "\"" },
    ],
};
