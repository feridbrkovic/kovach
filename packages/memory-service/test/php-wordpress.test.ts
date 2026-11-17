import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BlobStore,
  createHistoryStore,
  createMemoryStore,
  type Db,
  docbookToMarkdown,
  fetchDocs,
  type HistoryStore,
  manifestHash,
  migrate,
  openDatabase,
  packVersion,
  parseEntities,
  scanProject,
} from "../src/index.js";
import { wordpressVersions } from "../src/scanner.js";
import { fakeDocsFetcher } from "./helpers/fake-docs.js";

let dir: string;
let db: Db;
let h: HistoryStore;
let t: number;
let n: number;
const ids = (p: string) => `${p}_${String(++n).padStart(6, "0")}`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kovach-wp-"));
  db = openDatabase(":memory:");
  migrate(db);
  t = 1_000;
  n = 0;
  h = createHistoryStore(db, { blobs: new BlobStore(dir), now: () => ++t, newId: ids });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function folder(name: string, files: Record<string, string>) {
  const root = join(dir, name);
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), c);
  }
  return root;
}

const ENTITIES = `<!ENTITY return.success 'Returns &true; on success or &false; on failure.'>
<!ENTITY note.unused '<note><para>Never shown.</para></note>'>`;
const TITLES = `<entities><entity name="reftitle.description"><title>Description</title></entity>
<entity name="reftitle.parameters"><title>Parameters</title></entity>
<entity name="reftitle.changelog"><title>&Changelog;</title></entity>
<entity name="Changelog">Changelog</entity><entity name="Version">Version</entity><entity name="Description">Description</entity>
<entity name="null"><constant>null</constant></entity><entity name="true"><constant>true</constant></entity><entity name="false"><constant>false</constant></entity></entities>`;

const ARRAY_WALK = `<?xml version="1.0" encoding="utf-8"?>
<!-- $Revision$ -->
<refentry xml:id="function.array-walk" xmlns="http://docbook.org/ns/docbook">
 <refnamediv>
  <refname>array_walk</refname>
  <refpurpose>Apply a user supplied function to every member of an array</refpurpose>
 </refnamediv>
 <refsect1 role="description">
  &reftitle.description;
  <methodsynopsis>
   <type>true</type><methodname>array_walk</methodname>
   <methodparam><type class="union"><type>array</type><type>object</type></type><parameter role="reference">array</parameter></methodparam>
   <methodparam><type>callable</type><parameter>callback</parameter></methodparam>
   <methodparam choice="opt"><type>mixed</type><parameter>arg</parameter><initializer>&null;</initializer></methodparam>
  </methodsynopsis>
  <para>Applies the <parameter>callback</parameter> to each element; see <function>array_map</function>. &return.success;</para>
  <note><para>Keys can't be changed &unknown.entity;in the callback.</para></note>
 </refsect1>
 <refsect1 role="parameters">
  &reftitle.parameters;
  <variablelist>
   <varlistentry><term><parameter>array</parameter></term><listitem><para>The input array.</para></listitem></varlistentry>
  </variablelist>
 </refsect1>
 <refsect1 role="changelog">
  &reftitle.changelog;
  <informaltable><tgroup cols="2"><thead><row><entry>&Version;</entry><entry>&Description;</entry></row></thead>
  <tbody><row><entry>8.2.0</entry><entry>The return type is <type>true</type> now.</entry></row></tbody></tgroup></informaltable>
 </refsect1>
 <refsect1 role="examples">
  <example>
   <title><function>array_walk</function> example</title>
   <programlisting role="php">
<![CDATA[
<?php
$fruits = ["d" => "lemon"];
array_walk($fruits, fn(&$v) => $v = "<b>$v</b>"); // &amp; stays as written
?>
]]>
   </programlisting>
  </example>
 </refsect1>
</refentry>`;

describe("PHP manual (DocBook) to Markdown", () => {
  const entities = parseEntities(TITLES, parseEntities(ENTITIES));

  it("reads both entity formats", () => {
    expect(entities.get("return.success")).toBe("Returns &true; on success or &false; on failure.");
    expect(entities.get("reftitle.description")).toBe("<title>Description</title>");
  });

  it("turns a function page into headings, a PHP signature, definitions, a table and code", () => {
    const { markdown, id } = docbookToMarkdown(ARRAY_WALK, entities);
    expect(id).toBe("function.array-walk");
    expect(markdown).toMatch(/^# array_walk\n\nApply a user supplied function to every member of an array\n\n## Description/);
    expect(markdown).toContain("```php\narray_walk(array|object &$array, callable $callback, mixed $arg = null): true\n```");
    expect(markdown).toContain("Applies the `$callback` to each element; see `array_map()`. Returns `true` on success or `false` on failure.");
    expect(markdown).toContain("**Note:** Keys can't be changed in the callback."); // unknown entity dropped
    expect(markdown).toContain("## Parameters\n\n**array**\n\nThe input array.");
    expect(markdown).toContain("| 8.2.0 | The return type is true now. |");
    expect(markdown).toContain("**Example: array_walk example**");
    // Code is kept exactly as written (CDATA), entities and markup-like text included.
    expect(markdown).toContain('array_walk($fruits, fn(&$v) => $v = "<b>$v</b>"); // &amp; stays as written');
    expect(markdown).not.toMatch(/<\/?(para|refsect1|methodparam)/);
  });

  it("puts list items' text on the bullet", () => {
    const list = `<sect1><title>Algorithms</title><itemizedlist><listitem><simpara><constant>PASSWORD_DEFAULT</constant> - bcrypt.</simpara><para>May change.</para></listitem><listitem><para>Argon2.</para></listitem></itemizedlist></sect1>`;
    expect(docbookToMarkdown(list).markdown).toBe("# Algorithms\n\n- `PASSWORD_DEFAULT` - bcrypt.\n\nMay change.\n- Argon2.");
  });

  it("nests headings by section depth and outlines classes", () => {
    const chapter = `<chapter xml:id="language.oop5" xmlns="http://docbook.org/ns/docbook"><title>Classes and Objects</title>
      <sect1 xml:id="language.oop5.basic"><title>The Basics</title><para>A class starts with <literal>class</literal>.</para>
      <sect2><title>new</title><simpara>Creates an instance.</simpara></sect2></sect1></chapter>`;
    expect(docbookToMarkdown(chapter).markdown).toBe("# Classes and Objects\n\n## The Basics\n\nA class starts with `class`.\n\n### new\n\nCreates an instance.");
    const cls = `<phpdoc:classref xml:id="class.countable" xmlns="http://docbook.org/ns/docbook" xmlns:phpdoc="http://php.net/ns/phpdoc"><title>The Countable interface</title>
      <partintro><section><title>Interface synopsis</title><classsynopsis><ooclass><classname>Countable</classname></ooclass>
      <oointerface><interfacename>Stringable</interfacename></oointerface>
      <fieldsynopsis><modifier>public</modifier><modifier>const</modifier><type>int</type><varname>Countable::MAX</varname><initializer>10</initializer></fieldsynopsis>
      <methodsynopsis><modifier>public</modifier><type>int</type><methodname>count</methodname><void/></methodsynopsis></classsynopsis></section></partintro></phpdoc:classref>`;
    expect(docbookToMarkdown(cls).markdown).toContain("```php\nclass Countable implements Stringable {\n    public const int MAX = 10;\n    public function count(): int;\n}\n```");
  });
});

describe("WordPress, WooCommerce and PHP in a project", () => {
  it("reads versions from core, the WooCommerce plugin, theme and plugin headers, and composer", () => {
    const site = folder("site", {
      "wp-includes/version.php": "<?php\n$wp_version = '6.7.1';\n$wp_db_version = 58975;",
      "wp-content/plugins/woocommerce/woocommerce.php": "<?php\n/**\n * Plugin Name: WooCommerce\n * Version: 9.4.2\n */",
    });
    expect(wordpressVersions(site)).toEqual({ wordpress: "6.7.1", woocommerce: "9.4.2" });
    const theme = folder("theme", { "style.css": "/*\nTheme Name: Optics Child\nTemplate: storefront\nTested up to: 6.6\nRequires PHP: 8.1\n*/" });
    expect(wordpressVersions(theme)).toEqual({ wordpress: "6.6", php: "8.1" });
    const plugin = folder("plugin", {
      "optics-core.php": "<?php\n/**\n * Plugin Name: Optics Core\n * Requires at least: 6.4\n * WC requires at least: 8.0\n */",
      "readme.txt": "=== Optics Core ===\nTested up to: 6.7\nWC tested up to: 9.4\n",
      "helpers.php": "<?php function optics_x() {}",
    });
    expect(wordpressVersions(plugin)).toEqual({ wordpress: "6.7", woocommerce: "9.4" });
    const bedrock = folder("bedrock", { "composer.json": JSON.stringify({ require: { php: ">=8.2", "roots/wordpress": "^6.5", "wpackagist-plugin/woocommerce": "9.1.0" } }) });
    const card = scanProject(bedrock, "bedrock");
    expect(card.versions).toMatchObject({ php: "8.2", wordpress: "6.5", woocommerce: "9.1.0" });
    expect(card.stack).toEqual(["WordPress 6.5", "WooCommerce 9.1.0", "PHP 8.2"]);
    expect(scanProject(theme, "theme")).toMatchObject({ languages: ["PHP"], stack: ["WordPress 6.6", "PHP 8.1"] });
  });

  it("notices a WordPress upgrade in a theme's headers", () => {
    const theme = folder("theme", { "style.css": "/*\nTheme Name: T\nTested up to: 6.6\n*/" });
    const before = manifestHash(theme);
    writeFileSync(join(theme, "style.css"), "/*\nTheme Name: T\nTested up to: 6.7\n*/");
    expect(manifestHash(theme)).not.toBe(before);
  });

  it("keeps WordPress packs per x.y release and others per major", () => {
    expect(packVersion("wordpress", "6.7.1")).toBe("6.7");
    expect(packVersion("wordpress", "6.6")).toBe("6.6");
    expect(packVersion("woocommerce", "9.4.2")).toBe("9");
    expect(packVersion("php", "8.3")).toBe("8");
  });
});

const md = (title: string, body: string) => `---\ntitle: ${title}\n---\n\n${body}\n`;
const REPOS = {
  "php/doc-en": {
    "": {
      "language-snippets.ent": ENTITIES,
      "entities/entities.title.ent": TITLES,
      "entities/entities.php.ent": "<entities></entities>",
      "reference/array/functions/array-walk.xml": ARRAY_WALK,
      "reference/array/versions.xml": "<versions><function name='array_walk' from='PHP 4'/></versions>",
      "reference/imagick/functions/x.xml": "<refentry xml:id='x'><refnamediv><refname>not included</refname></refnamediv></refentry>",
      "language/types/array.xml": "<sect1 xml:id='language.types.array'><title>Arrays</title><para>An array in PHP is an ordered map: a type that associates values to keys, optimized for many different uses.</para></sect1>",
    },
  },
  "WordPress/gutenberg": {
    "wp/6.7": { "docs/reference-guides/block-api/block-metadata.md": md("Metadata in block.json", "Register blocks with a block.json file and register_block_type in WordPress 6.7; the metadata file is the canonical way.") },
    "": { "docs/reference-guides/block-api/block-metadata.md": md("Metadata in block.json", "Latest block.json docs: register blocks with a block.json file and register_block_type.") },
  },
  "WP-API/docs": {
    "": {
      "extending-the-rest-api/adding-custom-endpoints.md": md("Adding Custom Endpoints", "Use register_rest_route inside the rest_api_init action to add a custom route to the REST API."),
      "bin/templates/endpoint.md": "# template, not a page",
      "README.md": "# WP-API docs\n\nThis repository holds the REST API handbook pages and the tools that build them.",
    },
  },
  "WordPress/wpcs-docs": { "": { "wordpress-coding-standards/php.md": md("PHP Coding Standards", "Use real tabs for indentation, spaces for alignment, and Yoda conditions in comparisons.") } },
  "woocommerce/woocommerce": {
    "9.4.2": { "docs/extensions/payments.md": md("Payment gateways", "Extend WC_Payment_Gateway to add a payment method, then register it with the woocommerce_payment_gateways filter."), "plugins/woocommerce/readme.txt": "x" },
  },
};

describe("PHP, WordPress and WooCommerce docs packs", () => {
  const fetcher = () => fakeDocsFetcher(REPOS, { tags: { "woocommerce/woocommerce": ["9.3.0", "9.4.2", "9.5.0-rc.1", "10.0.1"] } });

  it("reads the PHP manual's chosen sections with its entities, linking pages to php.net", async () => {
    const f = fetcher();
    const built = await fetchDocs("php", "8.3", f);
    expect(built.plan.docsVersion).toBe("current");
    expect([...new Set(built.chunks.map((c) => c.path))].sort()).toEqual(["language/types/array.xml", "reference/array/functions/array-walk.xml"]);
    const walk = built.chunks.find((c) => c.path.endsWith("array-walk.xml") && /Description/.test(c.heading))!;
    expect(walk.text).toContain("Returns `true` on success");
    expect(walk.url).toBe("https://www.php.net/manual/en/function.array-walk.php#description");
    // Entity files are read but never indexed; versions.xml and other extensions aren't read at all.
    expect(f.reads).toContain("php/doc-en@:language-snippets.ent");
    expect(f.reads.some((r) => r.includes("imagick") || r.includes("versions.xml"))).toBe(false);
  });

  it("builds WordPress from the release's block editor docs plus the REST API handbook and coding standards", async () => {
    const built = await fetchDocs("wordpress", "6.7.1", fetcher());
    expect(built.plan).toMatchObject({ ref: "wp/6.7", docsVersion: "6.7" });
    expect(built.plan.note).toMatch(/Theme and Plugin handbooks aren't published/);
    const paths = [...new Set(built.chunks.map((c) => c.path))].sort();
    expect(paths).toEqual([
      "WP-API/docs:extending-the-rest-api/adding-custom-endpoints.md",
      "WordPress/wpcs-docs:wordpress-coding-standards/php.md",
      "docs/reference-guides/block-api/block-metadata.md",
    ]);
    expect(built.chunks.find((c) => c.path.includes("adding-custom-endpoints"))!.url).toMatch(/^https:\/\/github\.com\/WP-API\/docs\/blob\/HEAD\/extending-the-rest-api/);
    // A release without its own branch gets the latest docs, and says so.
    const old = await fetchDocs("wordpress", "5.9", fetcher());
    expect(old.plan).toMatchObject({ docsVersion: "latest" });
    expect(old.plan.note).toMatch(/^No block editor docs for WordPress 5\.9; using the latest/);
  });

  it("builds WooCommerce from the newest release of the project's major", async () => {
    const built = await fetchDocs("woocommerce", "9.1.0", fetcher());
    expect(built.plan).toMatchObject({ ref: "9.4.2", docsVersion: "9.4.2" });
    expect(built.chunks[0]!.text).toContain("WC_Payment_Gateway");
  });

  it("a WordPress theme gets all three packs without asking, and the agent can search them", async () => {
    const f = fetcher();
    const mem = createMemoryStore(db, { now: () => ++t, newId: ids, docsFetcher: () => f });
    mem.jobs.start();
    const root = folder("optics-child", { "style.css": "/*\nTheme Name: Optics Child\nTested up to: 6.7\nWC tested up to: 9.4\nRequires PHP: 8.3\n*/" });
    const id = h.ensureProject({ path: root, name: "optics-child" });
    const suggested = await mem.suggestDocPacks(id);
    expect(suggested.filter((s) => s.auto).map((s) => s.library).sort()).toEqual(["php", "woocommerce", "wordpress"]);
    expect(mem.ensureDocPacks(id)).toHaveLength(3);
    await mem.jobs.idle();
    const packs = await mem.listDocPacks(id);
    expect(packs.map((p) => [p.library, p.version, p.status]).sort()).toEqual([
      ["php", "8", "ready"],
      ["woocommerce", "9", "ready"],
      ["wordpress", "6.7", "ready"],
    ]);
    expect((await mem.searchDocs({ projectId: id, query: "register_rest_route custom endpoint" }))[0]).toMatchObject({ library: "wordpress" });
    expect((await mem.searchDocs({ projectId: id, query: "array_walk callback" }))[0]).toMatchObject({ library: "php", possiblyOutdated: false });
    expect((await mem.searchDocs({ projectId: id, query: "payment gateway", library: "woocommerce" }))[0]).toMatchObject({ docsVersion: "9.4.2", possiblyOutdated: false });
  });
});
