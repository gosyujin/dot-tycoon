#!/usr/bin/env python3
"""メガネ分類器の学習用データを Wikimedia Commons から集める（開発用）。

  python3 tools/collect_dataset.py list      # 対象ファイルの一覧と枚数だけ表示
  python3 tools/collect_dataset.py download  # dev-samples/train/{pos,neg}/ に 640px サムネイルを保存

- pos: 「メガネをかけた人」系カテゴリの写真
- neg: 「人物写真」系カテゴリの写真のうち、タイトル・カテゴリにメガネ関連語を含まないもの
ラベルはカテゴリ由来で多少ノイズがある（negにメガネの人が混じりうる）。
画像は dev-samples/ （git 管理外）に保存し、リポジトリには含めない。
"""
import json, os, re, subprocess, sys, time, urllib.parse

UA = "dot-tycoon-dev/0.1 (local training data collection; contact via repository)"
API = "https://commons.wikimedia.org/w/api.php"
OUT = os.path.join(os.path.dirname(__file__), "..", "dev-samples", "train")

POS_CATS = [
    "People wearing glasses", "Men wearing glasses", "Women wearing glasses", "Men with glasses",
    "Portrait photographs of men wearing glasses with beards", "Female people wearing glasses",
    "Male people wearing glasses", "Portrait photographs of women wearing glasses",
    "Portrait photographs of men wearing glasses", "Smiling men wearing glasses", "Smiling women wearing glasses",
]
NEG_CATS = [
    "Portrait photographs of young women", "Portrait photographs of men", "Portraits of adolescent girls",
    "Portrait photographs of women", "Portrait photographs of old men", "Portraits of young men",
    "Portrait photographs of old women", "Portrait photographs of young men", "Headshots",
    "Portrait photographs of unidentified women", "Portrait photographs of unidentified men",
]
BAD_TITLE = re.compile(r"glass|spectacle|sunglass|goggle|monocle|specs|eyewear|drawing|painting|statue|cartoon|\.(svg|png|gif|tif|tiff|pdf)$", re.I)
BAD_CAT = re.compile(r"glass|spectacle|eyewear|goggle|monocle", re.I)


CACHE = os.path.join(OUT, "_cache.json")


def api(params, retries=5):
    q = urllib.parse.urlencode({**params, "format": "json"})
    for i in range(retries):
        out = subprocess.run(["curl", "-s", "-A", UA, f"{API}?{q}"], capture_output=True, text=True).stdout
        try:
            return json.loads(out)
        except Exception:
            time.sleep(10 * (2 ** i))  # レート制限に当たったら長めに待つ
    raise RuntimeError("API failed: " + q[:120])


def category_files(cat, max_pages=3):
    """カテゴリ直下のファイルを、画像情報・所属カテゴリごと 1 回の呼び出しで取る"""
    res, cont = {}, {}
    for _ in range(max_pages):
        d = api({"action": "query", "generator": "categorymembers", "gcmtitle": "Category:" + cat,
                 "gcmtype": "file", "gcmlimit": "50", "prop": "imageinfo|categories",
                 "iiprop": "url|size", "iiurlwidth": "640", "cllimit": "max", **cont})
        for p in d.get("query", {}).get("pages", {}).values():
            ii = (p.get("imageinfo") or [{}])[0]
            t = p["title"]
            if not ii.get("thumburl") or not t.lower().endswith((".jpg", ".jpeg")) or BAD_TITLE.search(t): continue
            res[t] = {"url": ii["thumburl"], "w": ii["width"], "h": ii["height"],
                      "cats": [c["title"] for c in p.get("categories", [])]}
        if "continue" in d: cont = d["continue"]
        else: break
        time.sleep(2.5)
    return res


def collect(cats):
    cache = json.load(open(CACHE)) if os.path.exists(CACHE) else {}
    out = {}
    for c in cats:
        if c not in cache:
            try:
                cache[c] = category_files(c)
            except Exception as e:
                print("  skip", c, e, file=sys.stderr)
                continue
            os.makedirs(OUT, exist_ok=True)
            json.dump(cache, open(CACHE, "w"))
            print(f"  {c}: {len(cache[c])} files", flush=True)
            time.sleep(2.5)
        out.update(cache[c])
    return out


def is_jpeg(path):
    try:
        with open(path, "rb") as f:
            return f.read(2) == b"\xff\xd8"
    except OSError:
        return False


def sample(items, cap):
    """題名順に等間隔で cap 件に間引く（再実行しても同じ結果になる）"""
    keys = sorted(items)
    if len(keys) <= cap: return items
    step = len(keys) / cap
    return {keys[int(i * step)]: items[keys[int(i * step)]] for i in range(cap)}


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "list"
    pi = collect(POS_CATS)
    ni = collect(NEG_CATS)
    for t in list(ni):
        if t in pi or any(BAD_CAT.search(c) for c in ni[t]["cats"]): del ni[t]
    pi = {t: v for t, v in pi.items() if min(v["w"], v["h"]) >= 300}
    ni = {t: v for t, v in ni.items() if min(v["w"], v["h"]) >= 300}
    pi, ni = sample(pi, 350), sample(ni, 450)
    print(f"usable: pos={len(pi)} neg={len(ni)}", flush=True)
    if mode == "list": return
    manifest = []
    for label, items in (("pos", pi), ("neg", ni)):
        os.makedirs(os.path.join(OUT, label), exist_ok=True)
        for k, (t, v) in enumerate(sorted(items.items())):
            fn = f"{label}-{k:04d}.jpg"
            dst = os.path.join(OUT, label, fn)
            if not (os.path.exists(dst) and os.path.getsize(dst) > 2000 and is_jpeg(dst)):
                for attempt in range(4):
                    subprocess.run(["curl", "-s", "-A", UA, "-o", dst, v["url"]])
                    if is_jpeg(dst): break
                    time.sleep(15 * (attempt + 1))
                time.sleep(3.0)
            manifest.append({"file": f"{label}/{fn}", "label": label, "title": t})
            if k % 25 == 0: print(label, k, "/", len(items), flush=True)
    json.dump(manifest, open(os.path.join(OUT, "manifest.json"), "w"), ensure_ascii=False, indent=1)
    print("done", len(manifest))


main()
