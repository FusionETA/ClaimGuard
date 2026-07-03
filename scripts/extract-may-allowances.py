"""
Extract May 2026 payroll data (basic salary + allowances + deductions) from the PDF.
Outputs TypeScript PDF_DATA entries to stdout — replace the PDF_DATA array in
scripts/import-may-allowances.ts with this output.

Usage:
    python3 scripts/extract-may-allowances.py > /tmp/may-pdf-data.txt
"""
import re
import sys
from pathlib import Path

import pdfplumber

PDF_PATH = Path.home() / "Downloads" / "jan to may (2).pdf"
MAY_IDX = 4  # 0=Jan … 4=May

EXTRACT_KEYS = {
    # Salary
    "BASIC",
    # Allowances
    "PETROL ALL", "MV EXP.ALL", "OUT.EXP.ALL", "ADD.ALL",
    "MEAL", "HP EXP.ALL", "HOUSE ALL", "EXP.ALL", "REFUND",
    # Deductions
    "OTH. DEDUCTION", "ZAKAT",
}


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

                if label in EXTRACT_KEYS:
                    if label in current_data:
                        current_data[label] = [
                            a + b for a, b in zip(current_data[label], vals)
                        ]
                    else:
                        current_data[label] = vals

        if current_emp and current_data:
            employees[current_emp] = current_data

    return employees


def fmt_breakdown(fields: dict) -> str:
    allowance_keys = [
        "PETROL ALL", "MV EXP.ALL", "OUT.EXP.ALL", "ADD.ALL",
        "MEAL", "HP EXP.ALL", "HOUSE ALL", "EXP.ALL", "REFUND",
        "OTH. DEDUCTION", "ZAKAT",
    ]
    parts = []
    for key in allowance_keys:
        if key in fields:
            v = round(fields[key][MAY_IDX], 2)
            if v != 0:
                parts.append(f'"{key}": {v}')
    return "{ " + ", ".join(parts) + " }" if parts else "{}"


def main():
    print("Parsing PDF…", file=sys.stderr)
    data = parse_pdf()
    print(f"Found {len(data)} employees.", file=sys.stderr)

    output = []
    skipped_no_salary = []
    skipped_no_allowances = []

    for emp_no, fields in sorted(data.items()):
        basic_may = round(fields.get("BASIC", [0]*12)[MAY_IDX], 2)
        if basic_may == 0:
            skipped_no_salary.append(emp_no)
            continue

        breakdown = fmt_breakdown(fields)
        if breakdown == "{}":
            skipped_no_allowances.append(emp_no)
            continue

        line = (
            f'  {{ empNo: "{emp_no}", basicSalary: {basic_may}, '
            f'breakdown: {breakdown} }},'
        )
        output.append(line)

    print(f"Employees with salary + allowances/deductions: {len(output)}", file=sys.stderr)
    if skipped_no_salary:
        print(f"Skipped (no May salary): {len(skipped_no_salary)}", file=sys.stderr)
    if skipped_no_allowances:
        print(f"Skipped (salary only, no allowances/deductions): {len(skipped_no_allowances)}", file=sys.stderr)

    print("\n".join(output))


if __name__ == "__main__":
    main()
