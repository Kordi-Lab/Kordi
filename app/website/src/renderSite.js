function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function mark(className = '') {
  const classes = ['paint-mark', className].filter(Boolean).join(' ');
  return `<span class="${classes}" aria-hidden="true"><span></span></span>`;
}

function titleLines(title) {
  return title
    .split(' ')
    .reduce((lines, word) => {
      const current = lines.at(-1) ?? '';
      const next = current ? `${current} ${word}` : word;
      if (next.length > 17 && current) {
        lines.push(word);
      } else if (lines.length === 0) {
        lines.push(word);
      } else {
        lines[lines.length - 1] = next;
      }
      return lines;
    }, [])
    .map((line) => `<span class="hero-title-line">${escapeHtml(line)}</span>`)
    .join('');
}

function renderCards(items, className) {
  return items
    .map(
      (item) => `
        <article class="${className} ${className}--${escapeHtml(item.wash)}">
          <h3>${escapeHtml(item.title)}</h3>
          <p>${escapeHtml(item.body)}</p>
        </article>`,
    )
    .join('');
}

export function renderSite(content) {
  const nav = content.nav
    .map((item) => `<a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>`)
    .join('');

  const loops = content.intro.loops
    .map(
      (item) => `
        <li><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.body)}</span></li>`,
    )
    .join('');

  return `
    <div class="site">
      <header class="nav">
        <a class="brand" href="#top" aria-label="${escapeHtml(content.brand.name)} home">${mark()}<span>${escapeHtml(content.brand.name)}</span></a>
        <nav class="nav-links" aria-label="Main navigation">
          ${nav}
          <a class="nav-cta" href="mailto:${escapeHtml(content.brand.email)}">Contact</a>
        </nav>
      </header>

      <main id="top">
        <section class="hero" aria-labelledby="hero-title">
          <div class="hero-copy">
            <h1 id="hero-title">${titleLines(content.hero.title)}</h1>
            <p class="body">${escapeHtml(content.hero.description)}</p>
            <div class="actions">
              <a class="button" href="${escapeHtml(content.hero.primaryAction.href)}">${escapeHtml(content.hero.primaryAction.label)}</a>
              <a class="text-link" href="${escapeHtml(content.hero.secondaryAction.href)}">${escapeHtml(content.hero.secondaryAction.label)} →</a>
            </div>
          </div>

          <aside class="hero-note" aria-label="Kordi workflow summary">
            <h2>${escapeHtml(content.intro.title)}</h2>
            <p>${escapeHtml(content.intro.body)}</p>
            <ul class="loop-list">${loops}</ul>
          </aside>
        </section>

        <section class="section" id="mission" aria-labelledby="mission-title">
          <div class="section-head">
            <h2 id="mission-title">${escapeHtml(content.mission.title)}</h2>
            <p>${escapeHtml(content.mission.body)}</p>
          </div>
          <div class="principles">${renderCards(content.mission.principles, 'principle')}</div>
        </section>

        <section class="section" id="system" aria-labelledby="system-title">
          <div class="section-head">
            <h2 id="system-title">${escapeHtml(content.system.title)}</h2>
            <p>${escapeHtml(content.system.body)}</p>
          </div>
          <div class="system-grid">${renderCards(content.system.items, 'system-item')}</div>
        </section>

        <section class="section" id="journal" aria-labelledby="journal-title">
          <div class="section-head">
            <h2 id="journal-title">${escapeHtml(content.journal.title)}</h2>
            <p>${escapeHtml(content.journal.body)}</p>
          </div>
          <div class="journal-layout">
            <article class="blog">
              <div>
                <p class="meta">${escapeHtml(content.journal.firstPost.eyebrow)}</p>
                <h3>${escapeHtml(content.journal.firstPost.title)}</h3>
              </div>
              <p>${escapeHtml(content.journal.firstPost.summary)}</p>
            </article>
            <aside class="small-note">
              <strong>${escapeHtml(content.journal.firstPost.noteTitle)}</strong>
              ${escapeHtml(content.journal.firstPost.note)}
            </aside>
          </div>
        </section>
      </main>

      <footer class="footer">
        <a class="brand" href="#top">${mark('small')}<span>${escapeHtml(content.brand.name)}</span></a>
        <span>${escapeHtml(content.brand.tagline)}</span>
      </footer>
    </div>`;
}
