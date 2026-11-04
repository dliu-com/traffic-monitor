// traffic.dliu.com is deliberately not indexed, so it must not advertise URLs to search engines.
const fs = require('fs');
const path = require('path');

const web = path.join(__dirname, '..', 'web');
const read = (file) => fs.readFileSync(path.join(web, file), 'utf8');
const stack = fs.readFileSync(path.join(__dirname, '..', 'lib/traffic-monitor-stack.ts'), 'utf8');

describe('search indexing', () => {
  test('every response is noindex, and so is every page', () => {
    expect(stack).toContain("{ header: 'X-Robots-Tag', value: 'noindex, nofollow', override: true }");
    for (const file of fs.readdirSync(web).filter((f) => f.endsWith('.html'))) {
      expect(read(file)).toContain('<meta name="robots" content="noindex, nofollow">');
    }
  });

  test('no sitemap lists noindex URLs, and robots.txt lets crawlers see the noindex', () => {
    expect(fs.existsSync(path.join(web, 'sitemap.xml'))).toBe(false);
    const robots = read('robots.txt');
    expect(robots).not.toMatch(/^Sitemap:/im);
    expect(robots).not.toMatch(/^Disallow:\s*\S/im);
    expect(robots).toMatch(/^User-agent: \*\nAllow: \/$/m);
  });
});
