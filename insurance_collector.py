"""
보험 콘텐츠 수집 툴
네이버(블로그/카페/지식인), 구글, 유튜브, 인스타, 페이스북에서
보험 관련 게시글/영상/댓글 링크를 수집합니다.
"""

import requests
from bs4 import BeautifulSoup
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
from datetime import datetime
import time
import urllib.parse
import re

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "ko-KR,ko;q=0.9",
}

KEYWORDS = [
    "보험 추천",
    "보험 비교",
    "실비보험",
    "생명보험 추천",
    "암보험",
    "자동차보험 비교",
    "보험 가입 방법",
    "보험료 절약",
    "보험 리모델링",
    "AI 보험 분석",
]


def search_naver_blog(keyword, max_results=5):
    results = []
    query = urllib.parse.quote(keyword)
    url = f"https://search.naver.com/search.naver?where=blog&query={query}&sm=tab_opt&nso=so%3Add%2Cp%3A1m"
    try:
        r = requests.get(url, headers=HEADERS, timeout=10)
        soup = BeautifulSoup(r.text, "html.parser")
        items = soup.select("ul.lst_view li.bx")[:max_results]
        for item in items:
            title_tag = item.select_one("a.title_link")
            desc_tag = item.select_one("div.dsc_txt")
            if title_tag:
                results.append({
                    "플랫폼": "네이버 블로그",
                    "키워드": keyword,
                    "제목": title_tag.get_text(strip=True),
                    "링크": title_tag.get("href", ""),
                    "내용 요약": desc_tag.get_text(strip=True)[:100] if desc_tag else "",
                })
    except Exception as e:
        print(f"[블로그 오류] {keyword}: {e}")
    return results


def search_naver_cafe(keyword, max_results=5):
    results = []
    query = urllib.parse.quote(keyword)
    url = f"https://search.naver.com/search.naver?where=cafeblog&query={query}&sm=tab_opt&nso=so%3Add%2Cp%3A1m"
    try:
        r = requests.get(url, headers=HEADERS, timeout=10)
        soup = BeautifulSoup(r.text, "html.parser")
        items = soup.select("ul.lst_view li.bx")[:max_results]
        for item in items:
            title_tag = item.select_one("a.title_link")
            cafe_tag = item.select_one("a.cafe_name")
            desc_tag = item.select_one("div.dsc_txt")
            if title_tag:
                results.append({
                    "플랫폼": f"네이버 카페 ({cafe_tag.get_text(strip=True) if cafe_tag else ''})",
                    "키워드": keyword,
                    "제목": title_tag.get_text(strip=True),
                    "링크": title_tag.get("href", ""),
                    "내용 요약": desc_tag.get_text(strip=True)[:100] if desc_tag else "",
                })
    except Exception as e:
        print(f"[카페 오류] {keyword}: {e}")
    return results


def search_naver_kin(keyword, max_results=5):
    results = []
    query = urllib.parse.quote(keyword)
    url = f"https://search.naver.com/search.naver?where=kin&query={query}&sm=tab_opt&nso=so%3Add%2Cp%3A1m"
    try:
        r = requests.get(url, headers=HEADERS, timeout=10)
        soup = BeautifulSoup(r.text, "html.parser")
        items = soup.select("ul.lst_view li.bx")[:max_results]
        for item in items:
            title_tag = item.select_one("a.title_link")
            desc_tag = item.select_one("div.dsc_txt")
            if title_tag:
                results.append({
                    "플랫폼": "네이버 지식인",
                    "키워드": keyword,
                    "제목": title_tag.get_text(strip=True),
                    "링크": title_tag.get("href", ""),
                    "내용 요약": desc_tag.get_text(strip=True)[:100] if desc_tag else "",
                })
    except Exception as e:
        print(f"[지식인 오류] {keyword}: {e}")
    return results


def search_google(keyword, max_results=5):
    results = []
    query = urllib.parse.quote(f"{keyword} 보험")
    url = f"https://www.google.com/search?q={query}&hl=ko&num={max_results}&tbs=qdr:m"
    try:
        r = requests.get(url, headers=HEADERS, timeout=10)
        soup = BeautifulSoup(r.text, "html.parser")
        items = soup.select("div.g")[:max_results]
        for item in items:
            title_tag = item.select_one("h3")
            link_tag = item.select_one("a")
            desc_tag = item.select_one("div.VwiC3b")
            if title_tag and link_tag:
                href = link_tag.get("href", "")
                if href.startswith("/url?q="):
                    href = urllib.parse.unquote(href[7:].split("&")[0])
                if href.startswith("http"):
                    results.append({
                        "플랫폼": "구글",
                        "키워드": keyword,
                        "제목": title_tag.get_text(strip=True),
                        "링크": href,
                        "내용 요약": desc_tag.get_text(strip=True)[:100] if desc_tag else "",
                    })
    except Exception as e:
        print(f"[구글 오류] {keyword}: {e}")
    return results


def search_youtube(keyword, max_results=5):
    results = []
    query = urllib.parse.quote(f"{keyword} 보험")
    url = f"https://www.youtube.com/results?search_query={query}&sp=CAM%253D"
    try:
        r = requests.get(url, headers=HEADERS, timeout=10)
        pattern = r'"videoId":"([^"]+)".*?"title":\{"runs":\[\{"text":"([^"]+)"'
        matches = re.findall(pattern, r.text)
        seen = set()
        for vid_id, title in matches[:max_results * 2]:
            if vid_id not in seen:
                seen.add(vid_id)
                results.append({
                    "플랫폼": "유튜브",
                    "키워드": keyword,
                    "제목": title,
                    "링크": f"https://www.youtube.com/watch?v={vid_id}",
                    "내용 요약": "",
                })
            if len(results) >= max_results:
                break
    except Exception as e:
        print(f"[유튜브 오류] {keyword}: {e}")
    return results


def search_instagram(keyword, max_results=5):
    results = []
    query = urllib.parse.quote(f"site:instagram.com {keyword} 보험")
    url = f"https://www.google.com/search?q={query}&hl=ko&num={max_results}"
    try:
        r = requests.get(url, headers=HEADERS, timeout=10)
        soup = BeautifulSoup(r.text, "html.parser")
        items = soup.select("div.g")[:max_results]
        for item in items:
            title_tag = item.select_one("h3")
            link_tag = item.select_one("a")
            desc_tag = item.select_one("div.VwiC3b")
            if title_tag and link_tag:
                href = link_tag.get("href", "")
                if href.startswith("/url?q="):
                    href = urllib.parse.unquote(href[7:].split("&")[0])
                if "instagram.com" in href:
                    results.append({
                        "플랫폼": "인스타그램",
                        "키워드": keyword,
                        "제목": title_tag.get_text(strip=True),
                        "링크": href,
                        "내용 요약": desc_tag.get_text(strip=True)[:100] if desc_tag else "",
                    })
    except Exception as e:
        print(f"[인스타 오류] {keyword}: {e}")
    return results


def search_facebook(keyword, max_results=5):
    results = []
    query = urllib.parse.quote(f"site:facebook.com {keyword} 보험")
    url = f"https://www.google.com/search?q={query}&hl=ko&num={max_results}"
    try:
        r = requests.get(url, headers=HEADERS, timeout=10)
        soup = BeautifulSoup(r.text, "html.parser")
        items = soup.select("div.g")[:max_results]
        for item in items:
            title_tag = item.select_one("h3")
            link_tag = item.select_one("a")
            desc_tag = item.select_one("div.VwiC3b")
            if title_tag and link_tag:
                href = link_tag.get("href", "")
                if href.startswith("/url?q="):
                    href = urllib.parse.unquote(href[7:].split("&")[0])
                if "facebook.com" in href:
                    results.append({
                        "플랫폼": "페이스북",
                        "키워드": keyword,
                        "제목": title_tag.get_text(strip=True),
                        "링크": href,
                        "내용 요약": desc_tag.get_text(strip=True)[:100] if desc_tag else "",
                    })
    except Exception as e:
        print(f"[페이스북 오류] {keyword}: {e}")
    return results


def save_to_excel(all_results, filename):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "보험 콘텐츠"

    headers = ["플랫폼", "키워드", "제목", "링크", "내용 요약"]
    header_fill = PatternFill("solid", fgColor="2D5FA8")
    header_font = Font(bold=True, color="FFFFFF", size=11)

    for col, h in enumerate(headers, 1):
        cell = ws.cell(row=1, column=col, value=h)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal="center", vertical="center")

    ws.column_dimensions["A"].width = 22
    ws.column_dimensions["B"].width = 18
    ws.column_dimensions["C"].width = 45
    ws.column_dimensions["D"].width = 60
    ws.column_dimensions["E"].width = 50

    row_colors = {
        "네이버 블로그": "E8F4FD", "네이버 카페": "EDF7ED", "네이버 지식인": "FFF8E1",
        "구글": "F3E5F5", "유튜브": "FFEBEE", "인스타그램": "FCE4EC", "페이스북": "E8EAF6"
    }

    for row_idx, item in enumerate(all_results, 2):
        platform = item.get("플랫폼", "")
        platform_key = next((k for k in row_colors if platform.startswith(k)), None)
        fill_color = row_colors.get(platform_key, "FFFFFF") if platform_key else "FFFFFF"

        for col, key in enumerate(headers, 1):
            cell = ws.cell(row=row_idx, column=col, value=item.get(key, ""))
            cell.fill = PatternFill("solid", fgColor=fill_color)
            cell.alignment = Alignment(wrap_text=True, vertical="top")
            if key == "링크":
                cell.font = Font(color="0563C1", underline="single")

    ws.row_dimensions[1].height = 25
    for r in range(2, len(all_results) + 2):
        ws.row_dimensions[r].height = 40

    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:E{len(all_results) + 1}"

    wb.save(filename)
    print(f"\n✅ 저장 완료: {filename}")
    print(f"   총 {len(all_results)}개 링크 수집")


def run(keywords=None, results_per_source=5):
    if keywords is None:
        keywords = KEYWORDS

    all_results = []
    searchers = [
        search_naver_blog,
        search_naver_cafe,
        search_naver_kin,
        search_google,
        search_youtube,
        search_instagram,
        search_facebook,
    ]

    for keyword in keywords:
        print(f"\n🔍 검색 중: '{keyword}'")
        for fn in searchers:
            results = fn(keyword, max_results=results_per_source)
            all_results.extend(results)
            print(f"   {fn.__name__}: {len(results)}개")
            time.sleep(1)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M")
    filename = f"보험_콘텐츠_{timestamp}.xlsx"
    save_to_excel(all_results, filename)
    return all_results


if __name__ == "__main__":
    run()
