/**
 * Which grammar parses which files, and the Tree-sitter queries that find
 * definitions (@def.<kind>) and uses (@ref) of names in them.
 */

export interface LanguageSpec {
  /** Grammar file in @vscode/tree-sitter-wasm: tree-sitter-<grammar>.wasm */
  grammar: string;
  extensions: string[];
  /** Definitions: captures named def.<kind>, e.g. @def.function. */
  defs: string;
  /** Uses of a name: calls, `new`, types, JSX tags, hook callbacks. Captures named ref. */
  refs: string;
}

const TS_DEFS = `
(function_declaration name: (identifier) @def.function)
(generator_function_declaration name: (identifier) @def.function)
(class_declaration name: (type_identifier) @def.class)
(abstract_class_declaration name: (type_identifier) @def.class)
(interface_declaration name: (type_identifier) @def.interface)
(type_alias_declaration name: (type_identifier) @def.type)
(enum_declaration name: (identifier) @def.enum)
(method_definition name: (property_identifier) @def.method)
(abstract_method_signature name: (property_identifier) @def.method)
(variable_declarator name: (identifier) @def.function value: [(arrow_function) (function_expression)])
(program (lexical_declaration (variable_declarator name: (identifier) @def.variable)))
(program (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @def.variable))))
`;
const TS_REFS = `
(call_expression function: (identifier) @ref)
(call_expression function: (member_expression property: (property_identifier) @ref))
(new_expression constructor: (identifier) @ref)
(type_identifier) @ref
(jsx_opening_element name: (identifier) @ref)
(jsx_self_closing_element name: (identifier) @ref)
`;

const JS_DEFS = `
(function_declaration name: (identifier) @def.function)
(generator_function_declaration name: (identifier) @def.function)
(class_declaration name: (identifier) @def.class)
(method_definition name: (property_identifier) @def.method)
(variable_declarator name: (identifier) @def.function value: [(arrow_function) (function_expression)])
(program (lexical_declaration (variable_declarator name: (identifier) @def.variable)))
(program (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @def.variable))))
`;
const JS_REFS = `
(call_expression function: (identifier) @ref)
(call_expression function: (member_expression property: (property_identifier) @ref))
(new_expression constructor: (identifier) @ref)
(jsx_opening_element name: (identifier) @ref)
(jsx_self_closing_element name: (identifier) @ref)
`;

export const LANGUAGES: LanguageSpec[] = [
  { grammar: "typescript", extensions: [".ts", ".mts", ".cts"], defs: TS_DEFS, refs: TS_REFS.replace(/^\(jsx.*$/gm, "") },
  { grammar: "tsx", extensions: [".tsx"], defs: TS_DEFS, refs: TS_REFS },
  { grammar: "javascript", extensions: [".js", ".jsx", ".mjs", ".cjs"], defs: JS_DEFS, refs: JS_REFS },
  {
    grammar: "php",
    extensions: [".php"],
    defs: `
(class_declaration name: (name) @def.class)
(interface_declaration name: (name) @def.interface)
(trait_declaration name: (name) @def.trait)
(enum_declaration name: (name) @def.enum)
(function_definition name: (name) @def.function)
(method_declaration name: (name) @def.method)
(const_element (name) @def.constant)
`,
    refs: `
(function_call_expression function: (name) @ref)
(function_call_expression function: (qualified_name (name) @ref))
(member_call_expression name: (name) @ref)
(nullsafe_member_call_expression name: (name) @ref)
(scoped_call_expression name: (name) @ref)
(object_creation_expression (name) @ref)
(object_creation_expression (qualified_name (name) @ref))
(named_type (name) @ref)
(base_clause (name) @ref)
(class_interface_clause (name) @ref)
((function_call_expression
   function: (name) @_hook
   arguments: (arguments (argument (string (string_content) @ref))))
 (#match? @_hook "^(add_action|add_filter|remove_action|remove_filter|do_action|apply_filters|add_shortcode|register_activation_hook|register_deactivation_hook)$"))
`,
  },
  {
    grammar: "python",
    extensions: [".py"],
    defs: `
(function_definition name: (identifier) @def.function)
(class_definition name: (identifier) @def.class)
`,
    refs: `
(call function: (identifier) @ref)
(call function: (attribute attribute: (identifier) @ref))
`,
  },
  {
    grammar: "go",
    extensions: [".go"],
    defs: `
(function_declaration name: (identifier) @def.function)
(method_declaration name: (field_identifier) @def.method)
(type_spec name: (type_identifier) @def.type)
`,
    refs: `
(call_expression function: (identifier) @ref)
(call_expression function: (selector_expression field: (field_identifier) @ref))
(type_identifier) @ref
`,
  },
];

export function languageFor(path: string): LanguageSpec | undefined {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = path.slice(dot).toLowerCase();
  return LANGUAGES.find((l) => l.extensions.includes(ext));
}
