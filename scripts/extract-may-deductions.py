"""
Extract May 2026 OTH. DEDUCTION and ZAKAT amounts from the payroll PDF.
Prints employees who have non-zero values for either column in May (month index 4).

Usage:
    python3 scripts/extract-may-deductions.py
"""
import re
from pathlib import Path
import pdfplumber

PDF_PATH = Path.home() / "Downloads" / "jan to may (2).pdf"
MAY_IDX = 4  # 0=Jan … 4=May

DEDUCTION_KEYS = {"OTH. DEDUCTION", "ZAKAT"}


def parse_pdf():
    employees = {}
    current_emp = None
    current_data = {}

    with pdfplumber.open(PDF_PATH) as pdf:
        for page in pdf.pages:
            text = page.extract_text() or ""
            for line in text.splitlines():
                emp_match = re.match(r"EMPLOYEE NO\.\s*:\s*(\S+)", line)
                if emp_match:
                    if current_emp and current_data:
                        employees[current_emp] = current_data
                    current_emp = emp_match.group(1).strip()
                    current_data = {}
                    continue

                if current_emp is None:
                    continue

                nums = re.findall(r"-?\d+\.\d+", line)
                if len(nums) < 12:
                    continue

                vals = [float(x) for x in nums[:12]]
                label = re.sub(r"^\d+\s+", "", line).strip()
                label = re.sub(r"\s+-?\d+\.\d+.*", "", label).strip()

                if label in DEDUCTION_KEYS:
                    current_data[label] = vals

        if current_emp and current_data:
            employees[current_emp] = current_data

    return employees


def main():
    print("Parsing PDF…")
    data = parse_pdf()

    results = []
    for emp_no, fields in sorted(data.items()):
        oth = round(fields.get("OTH. DEDUCTION", [0]*12)[MAY_IDX], 2)
        zakat = round(fields.get("ZAKAT", [0]*12)[MAY_IDX], 2)
        if oth != 0 or zakat != 0:
            results.append((emp_no, oth, zakat))

    print(f"\nFound {len(results)} employees with deductions in May 2026:\n")
    print(f"{'EmpNo':<12} {'OTH. DEDUCTION':>16} {'ZAKAT':>10}")
    print("-" * 42)
    for emp_no, oth, zakat in results:
        print(f"{emp_no:<12} {oth:>16.2f} {zakat:>10.2f}")


if __name__ == "__main__":
    main()
