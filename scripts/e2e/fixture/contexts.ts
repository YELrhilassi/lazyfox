// The BiDi context tree, flattened.
//
// Its own module because two otherwise-independent concerns need it — `pages`
// (find the command-center tabs) and `tabs` (the tree fallback when the
// extension realm cannot answer a count) — and importing it from the
// composition root to get it would make both of them depend on everything.

// Recursively collect every browsing context (tabs and iframes) in the tree.
export function contextsOf(tree) {
  const all = [];
  const walk = (cs) => {
    for (const c of cs) {
      all.push(c);
      if (c.children) walk(c.children);
    }
  };
  walk(tree);
  return all;
}