(async function () {
  const data = await (await fetch('/api/graph')).json();
  const el = document.getElementById('graph');
  const side = document.getElementById('side');
  if (!data.nodes.length) { el.innerHTML = "<p class='muted' style='padding:18px'>Upload a few books to see the graph.</p>"; return; }
  const W = el.clientWidth, H = el.clientHeight;
  const svg = d3.select(el).append('svg').attr('viewBox', [0, 0, W, H]);
  const g = svg.append('g');
  svg.call(d3.zoom().scaleExtent([0.2, 5]).on('zoom', ev => g.attr('transform', ev.transform)));
  svg.append('defs').append('marker').attr('id', 'arrow').attr('viewBox', '0 -4 8 8').attr('refX', 14).attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
    .append('path').attr('d', 'M0,-4L8,0L0,4').attr('fill', 'currentColor').style('color', 'var(--muted)');

  const nodes = data.nodes.map(d => ({ ...d }));
  const links = data.edges.map(d => ({ ...d }));
  const deg = Object.fromEntries(nodes.map(n => [n.id, n.in + n.out]));
  const r = d => 4 + Math.sqrt(deg[d.id]) * 2;
  const wmax = d3.max(links, l => l.n) || 1;

  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(l => 60 + 80 / Math.sqrt(l.n)))
    .force('charge', d3.forceManyBody().strength(-160))
    .force('center', d3.forceCenter(W / 2, H / 2))
    .force('collide', d3.forceCollide(d => r(d) + 12));

  const link = g.append('g').selectAll('line').data(links).join('line').attr('class', 'link')
    .attr('stroke-width', l => 0.6 + 3 * l.n / wmax).attr('marker-end', 'url(#arrow)');
  const node = g.append('g').selectAll('g').data(nodes).join('g').attr('class', 'node').style('cursor', 'pointer')
    .call(d3.drag().on('start', (ev, d) => { if (!ev.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (ev, d) => { d.fx = ev.x; d.fy = ev.y; })
      .on('end', (ev, d) => { if (!ev.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));
  node.append('circle').attr('r', r).attr('fill', d => d.uploaded ? 'var(--accent)' : 'var(--card)').attr('stroke', 'var(--accent)').attr('stroke-width', 1.5);
  node.append('text').attr('dx', d => r(d) + 4).attr('dy', 4).text(d => d.id);

  sim.on('tick', () => {
    link.attr('x1', l => l.source.x).attr('y1', l => l.source.y).attr('x2', l => l.target.x).attr('y2', l => l.target.y);
    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });

  function focus(d) {
    if (!d) { link.style('opacity', 1); node.style('opacity', 1); side.innerHTML = ''; return; }
    const near = new Set([d.id]);
    links.forEach(l => { if (l.source.id === d.id) near.add(l.target.id); if (l.target.id === d.id) near.add(l.source.id); });
    node.style('opacity', n => near.has(n.id) ? 1 : 0.12);
    link.style('opacity', l => l.source.id === d.id || l.target.id === d.id ? 1 : 0.06);
    const out = links.filter(l => l.source.id === d.id).sort((a, b) => b.n - a.n);
    const inn = links.filter(l => l.target.id === d.id).sort((a, b) => b.n - a.n);
    const li = l => `<li>${l.source.id === d.id ? l.target.id : l.source.id} <span class='muted small'>${l.n} mention${l.n > 1 ? 's' : ''}, ${l.n_works} work${l.n_works > 1 ? 's' : ''}</span></li>`;
    side.innerHTML = `<h2>${d.id}</h2>` +
      (out.length ? `<p class='muted'>Cites</p><ul>${out.map(li).join('')}</ul>` : '') +
      (inn.length ? `<p class='muted'>Cited by</p><ul>${inn.map(li).join('')}</ul>` : '') +
      `<p><button class='link' id='clear'>clear</button></p>`;
    document.getElementById('clear').onclick = () => focus(null);
  }
  node.on('click', (ev, d) => { ev.stopPropagation(); focus(d); });
  svg.on('click', () => focus(null));
})();
