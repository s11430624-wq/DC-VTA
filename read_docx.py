import zipfile
import xml.etree.ElementTree as ET
import os

def read_docx(file_path):
    try:
        if not os.path.exists(file_path):
            return f"Error: File not found at {file_path}"
            
        with zipfile.ZipFile(file_path) as docx:
            xml_content = docx.read('word/document.xml')
            root = ET.fromstring(xml_content)
            
            # OpenXML namespaces
            namespaces = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
            
            paragraphs = []
            # Find all paragraph elements <w:p>
            for p in root.findall('.//w:p', namespaces):
                texts = []
                # In each paragraph, find all text elements <w:t>
                for t in p.findall('.//w:t', namespaces):
                    if t.text:
                        texts.append(t.text)
                paragraphs.append(''.join(texts))
            
            return '\n'.join(paragraphs)
    except Exception as e:
        return f"Error reading docx: {str(e)}"

if __name__ == "__main__":
    path = r"C:\Users\s9207\Downloads\論文計畫書：AI 互動教學系统 V3.docx"
    # 也支持 Unicode 的 "論文計畫書：AI 互動教學系統 V3.docx"
    # 用 sys.argv 來動態傳入或直接寫死，我們直接檢查兩個可能的名字
    alternative_path = r"C:\Users\s9207\Downloads\論文計畫書：AI 互動教學系統 V3.docx"
    
    if os.path.exists(alternative_path):
        text = read_docx(alternative_path)
    else:
        text = read_docx(path)
        
    print(text)
