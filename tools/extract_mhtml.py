# extract_mhtml.py — 把浏览器另存的 MHTML 快照转成离线单文件测试页
#
# 用途: 网络不通（Cloudflare 拦 curl）时，用本地快照做扩展端到端测试。
# 1. 解析 MHTML 各 MIME 部分，图片按 Content-Location 映射为 data: URI 内嵌
# 2. 内嵌 <link> 样式表（wiki 的 light-invert 等图标样式依赖站点 CSS）
# 3. 剔除 <script> 与上次翻译残留（.tw-tr / #tw-fab-host / #tw-style），
#    让扩展在测试里重新完整采集翻译
#
# 用法: python -I tools/extract_mhtml.py <in.mhtml> <out.html> [页面URL]
import base64
import email
import re
import sys
from email import policy
from urllib.parse import urlparse

in_path, out_path = sys.argv[1], sys.argv[2]
page_url = sys.argv[3] if len(sys.argv) > 3 else None

with open(in_path, 'rb') as f:
    msg = email.message_from_binary_file(f, policy=policy.default)

html = None
images = {}   # key: basename(去query) → data URI
cids = {}     # key: Content-ID → data URI
styles = []   # 内嵌 CSS 文本

def norm_key(url):
    return urlparse(url).path.rsplit('/', 1)[-1].lower()

for part in msg.walk():
    ctype = part.get_content_type()
    loc = part.get('Content-Location', '')
    cid = part.get('Content-ID', '')
    payload = part.get_payload(decode=True)
    if not payload:
        continue
    if ctype.startswith('image/'):
        b64 = base64.b64encode(payload).decode('ascii')
        uri = f'data:{ctype};base64,{b64}'
        if loc:
            images[norm_key(loc)] = uri
        if cid:
            cids[cid.strip('<>').split('@')[0]] = uri
        continue
    if ctype == 'text/css':
        styles.append(payload.decode(part.get_content_charset() or 'utf-8', errors='replace'))
        continue
    if page_url and ctype == 'text/html' and loc and loc.rstrip('/').endswith(urlparse(page_url).path):
        charset = part.get_content_charset() or 'utf-8'
        html = payload.decode(charset, errors='replace')

if html is None:
    sys.exit('未找到主 HTML 部分（MHTML 内无匹配 text/html 文档）')

# CSS 内部的图片引用也换成 data URI（能换多少换多少，缺资源不致命）
css_inlined = []
for css in styles:
    def sub_url(m):
        key = norm_key(m.group(2))
        return f'{m.group(1)}{images[key]}{m.group(3)}' if key in images else m.group(0)
    css = re.sub(r'''(url\(["']?)([^"')]+)(["']?\))''', sub_url, css)
    css_inlined.append(css)

# HTML 里的图片引用 → data URI
def sub_attr(m):
    attr, val = m.group(1), m.group(2)
    if attr == 'srcset':
        parts = []
        for entry in val.split(','):
            tokens = entry.strip().split()
            if tokens and norm_key(tokens[0]) in images:
                tokens[0] = images[norm_key(tokens[0])]
            parts.append(' '.join(tokens))
        return f'srcset="{", ".join(parts)}"'
    key = norm_key(val)
    return f'{attr}="{images[key]}"' if key in images else m.group(0)

html = re.sub(r'(src)="([^"]+)"', sub_attr, html)
html = re.sub(r'''(srcset)="([^"]+)"''', sub_attr, html)

# cid: 引用 → data URI
def sub_cid(m):
    key = m.group(1).split('@')[0]
    if key in cids:
        return f'src="{cids[key]}"'
    return m.group(0)
html = re.sub(r'src="cid:([^"]+)"', sub_cid, html)

# <link rel=stylesheet> → 内嵌 <style>
link_re = re.compile(r'<link\b[^>]*rel=["\']stylesheet["\'][^>]*>', re.I)
def sub_link(m):
    tag = m.group(0)
    href = re.search(r'href=["\']([^"\']+)', tag)
    if href and norm_key(href.group(1)) in images:
        return ''
    return tag
html = link_re.sub(sub_link, html)
if css_inlined:
    style_block = '<style>\n' + '\n'.join(css_inlined) + '\n</style>'
    html = re.sub(r'</head>', style_block + '\n</head>', html, count=1)

# 剔除脚本与上次翻译残留
html = re.sub(r'<script\b[^>]*>[\s\S]*?</script>', '', html, flags=re.I)
html = re.sub(r'<script\b[^>]*/>', '', html, flags=re.I)
html = re.sub(r'<div class="tw-tr[^"]*"[^>]*>[\s\S]*?</div>', '', html)
html = re.sub(r'<div id="tw-fab-host"[\s\S]*?</div>', '', html)
html = re.sub(r'<style id="tw-style">[\s\S]*?</style>', '', html)

with open(out_path, 'w', encoding='utf-8') as f:
    f.write(html)

n_img = html.count('data:image/')
print(f'输出 {out_path}: {len(html)} 字符, 内嵌图片引用 {n_img} 处, CSS {len(css_inlined)} 个')
missing = re.findall(r'src="([^"]*\.(?:png|jpg|jpeg|gif|webp|svg)[^"]*)"', html)
missing = [m for m in missing if not m.startswith('data:')]
if missing:
    print(f'未内嵌的图片引用 {len(missing)} 个, 例: {missing[:5]}')
