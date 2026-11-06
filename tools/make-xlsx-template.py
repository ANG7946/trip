# 產生 Excel 範本：欄名與範例列取自 CSV 範本，確保兩者一致
import csv, io, sys
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.utils import get_column_letter

csv_path, out = sys.argv[1], sys.argv[2]
rows = list(csv.reader(io.open(csv_path, encoding='utf-8-sig')))
header, examples = rows[0], rows[1:]

wb = Workbook()
ws = wb.active
ws.title = '行程'
navy = PatternFill('solid', fgColor='0B2545')
thin = Side(style='thin', color='C9CED6')
ws.append(header)
for c in ws[1]:
    c.font = Font(bold=True, color='FFFFFF')
    c.fill = navy
    c.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
ws.row_dimensions[1].height = 30
widths = {'日期': 12, '順序': 6, '城市': 12, '名稱': 20, '當地名稱': 24, '類型': 9, '開始時間': 9, '結束時間': 9,
          '地址': 34, '座標': 20, '入口座標': 20, '交通方式': 11, '已確認地點': 10, '參考網址': 28, '備註': 40}
for i, h in enumerate(header, 1):
    ws.column_dimensions[get_column_letter(i)].width = widths.get(h, 14)

# 日期、時間、座標設為「文字」格式，避免 Excel 自動轉成序號或數字
text_cols = {'日期', '開始時間', '結束時間', '座標', '入口座標', '順序'}
MAX_ROW = 300
for i, h in enumerate(header, 1):
    if h in text_cols:
        for r in range(2, MAX_ROW + 1):
            ws.cell(row=r, column=i).number_format = '@'
for r_i, row in enumerate(examples, 2):
    for c_i, val in enumerate(row, 1):
        cell = ws.cell(row=r_i, column=c_i, value=val if val != '' else None)
        cell.number_format = '@' if header[c_i - 1] in text_cols else cell.number_format
        cell.border = Border(top=thin, bottom=thin, left=thin, right=thin)
        cell.alignment = Alignment(vertical='top', wrap_text=header[c_i - 1] in {'備註', '地址'})

def col(name):
    return get_column_letter(header.index(name) + 1)

def add_list(name, items, prompt):
    dv = DataValidation(type='list', formula1='"' + ','.join(items) + '"', allow_blank=True,
                        showErrorMessage=True, errorTitle='請從清單選擇', error=f'「{name}」請從下拉清單選擇。',
                        showInputMessage=True, promptTitle=name, prompt=prompt)
    ws.add_data_validation(dv)
    dv.add(f'{col(name)}2:{col(name)}{MAX_ROW}')

add_list('類型', ['景點', '住宿', '會議', '車站', '交通', '用餐', '其他'], '可留空（預設：景點）')
add_list('交通方式', ['步行', '大眾運輸', '開車', '自行車'], '前往此地的預設方式；可留空')
add_list('已確認地點', ['是'], '只有親自在地圖上核對過目的地才選「是」；否則留空')

def add_prompt(name, title, msg):
    dv = DataValidation(type='custom', formula1='TRUE', allow_blank=True, showInputMessage=True, promptTitle=title, prompt=msg)
    ws.add_data_validation(dv)
    dv.add(f'{col(name)}2:{col(name)}{MAX_ROW}')

add_prompt('日期', '日期', '格式 2026-11-12；留空＝候選景點')
add_prompt('座標', '座標', '緯度, 經度，例：48.1982, 16.3719；不確定就留空')
add_prompt('入口座標', '入口座標', '入口的 緯度, 經度；有填時導航優先使用')
add_prompt('開始時間', '開始時間', '24 小時制，例：09:30；彈性行程可留空')
add_prompt('名稱', '名稱', '必填')

ws.freeze_panes = 'E2'
ws.auto_filter.ref = f'A1:{get_column_letter(len(header))}1'

# ---------- 填寫說明 ----------
g = wb.create_sheet('填寫說明')
g.column_dimensions['A'].width = 20
g.column_dimensions['B'].width = 70
title = g.cell(row=1, column=1, value='旅程導航助手｜Excel 行程範本填寫說明')
title.font = Font(bold=True, size=14)
g.merge_cells('A1:B1')
lines = [
    ('', ''),
    ('使用方式', '在「行程」分頁填寫，每一列是一個停靠點；範例列可直接刪除。第一列欄名請勿修改。'),
    ('匯入', '存檔後把檔案傳到手機，在 App 首頁「我的旅程 → 匯入檔案」選取此 .xlsx 即可；不需要另存 CSV。App 只讀取「行程」分頁。'),
    ('相容性', '欄名與規則和 CSV 範本完全相同；Google 試算表或 Numbers 使用者也可匯出 CSV 後匯入。'),
    ('', ''),
    ('欄位', '填寫方式'),
    ('日期', '2026-11-12（也接受 2026/11/12）。留空＝候選景點（尚未決定日期）。'),
    ('順序', '同一天的先後（數字）。可留空＝依列的上下順序。App 的「下一站」依此順序，不依時間排列。'),
    ('城市', 'Vienna、Budapest、Bratislava…。只有名稱沒有地址時，導航需要城市才能搜尋。同一天可以有不同城市。'),
    ('名稱', '必填。建議用中文顯示名稱。'),
    ('當地名稱', '當地語言原名，例：Karlskirche、Halászbástya。導航會優先用原名搜尋，較準確。'),
    ('類型', '下拉選擇：景點、住宿、會議、車站、交通、用餐、其他。可留空（預設：景點）。'),
    ('開始時間／結束時間', '24 小時制，例：09:30。彈性的觀光行程可留空；火車、會議等固定時段才需填寫。'),
    ('地址', '完整地址（含門牌、郵遞區號、城市）最可靠。'),
    ('座標', '格式「緯度, 經度」，緯度在前，例：48.1982, 16.3719。只填有可靠來源的座標（例如自己在 Apple Maps／Google 地圖長按複製）；不確定就留空、改填地址。'),
    ('入口座標', '格式同上。火車站、大型景點、飯店建議填入口，避免導到建築中心。有填時導航優先使用：入口座標 → 座標 → 地址 → 名稱＋城市。'),
    ('交通方式', '下拉選擇：步行、大眾運輸、開車、自行車。前往此地的預設方式，App 內可臨時切換。'),
    ('已確認地點', '只有親自在地圖上核對過目的地正確，才選「是」；其他情況一律留空。AI 查到但未經本人核對的地點也請留空，App 會標示「定位待確認」提醒。'),
    ('參考網址', '必須是 https:// 開頭，例如官方網站或票券查詢頁。'),
    ('備註', '純文字。請勿填入訂位代碼、護照號碼、付款資訊或任何密碼。'),
    ('', ''),
    ('不需要的欄位', '「已完成／略過」由 App 內手動標記，不在此範本中。'),
    ('隱私', '含真實行程的檔案請勿上傳到公開網站；資料匯入後只存在您自己的手機。'),
]
for i, (a, b) in enumerate(lines, 2):
    ca = g.cell(row=i, column=1, value=a or None)
    cb = g.cell(row=i, column=2, value=b or None)
    ca.font = Font(bold=True)
    ca.alignment = Alignment(vertical='top')
    cb.alignment = Alignment(wrap_text=True, vertical='top')
    if a == '欄位':
        for c in (ca, cb):
            c.font = Font(bold=True, color='FFFFFF'); c.fill = navy
wb.active = 0
wb.save(out)
print('saved', out)
