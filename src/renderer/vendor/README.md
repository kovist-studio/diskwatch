# Vendored

The renderer is sandboxed (no `require`), has no bundler, and loads nothing
over the network — so a third-party library has to arrive as a plain
`<script>` tag from inside the renderer directory. These files are copied
verbatim from `node_modules`, never edited.

| file | package | version |
| --- | --- | --- |
| `d3-hierarchy.js` | [d3-hierarchy](https://github.com/d3/d3-hierarchy) (ISC) | 3.1.2 |

This is the **unminified** UMD build on purpose. Auditability is the point of
this project: a reader should be able to open any file the app runs and read
it. A 16K minified blob would be smaller and unreadable.

## Verify it matches the package

```sh
npm run verify:vendor
```

That re-derives the checksum from `node_modules` and compares. To update after
bumping the dependency, run `npm run sync:vendor` and commit the result.
