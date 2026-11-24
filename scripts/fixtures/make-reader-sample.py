"""Create the 180-page PDF used by pdf-reader-check.mjs (ReportLab and Pillow)."""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas

output = Path(sys.argv[1])
pdf = Canvas(str(output), pagesize=(612, 792), invariant=1, pageCompression=0)
pdf.setTitle("Systems handbook")

scan = Image.new("RGB", (900, 180), "white")
font = ImageFont.truetype(sys.argv[2] if len(sys.argv) > 2 else "arial.ttf", 58)
ImageDraw.Draw(scan).text((45, 40), "READ THE SCANNED PAGE", font=font, fill="black")
for page in range(1, 181):
    if page == 92:
        pdf.drawImage(ImageReader(scan), 50, 595, width=510, height=102)
    else:
        pdf.setFont("Helvetica", 9)
        pdf.drawString(50, 766, "Systems handbook / reader edition")
        pdf.drawString(300, 30, str(page))
        if page == 95:
            pdf.bookmarkPage("experiments")
            pdf.addOutlineEntry("Trace analysis", "experiments")
        if page not in (94, 95, 96):
            pdf.setFont("Helvetica-Bold", 17)
            pdf.drawString(50, 703, f"Section {page}. Reading experiments")
        pdf.setFont("Helvetica", 11)
        if page == 90:
            for row in range(5):
                for x, name in [(50, "Left"), (330, "Right")]:
                    pdf.drawString(x, 652 - row * 14, f"{name} column line {row + 1}.")
        elif page == 91:
            cells = [["Item", "Quantity", "Price"], ["Widget", "12", "3.50"], ["Gadget", "4", "9.00"]]
            for row, values in enumerate(cells):
                for x, value in zip([50, 225, 410], values):
                    pdf.drawString(x, 652 - row * 14, value)
        else:
            for row in range(34):
                pdf.drawString(50, 662 - row * 16, f"Page {page}, line {row + 1}. The service stores each record in a durable queue.")
    pdf.showPage()
pdf.save()
