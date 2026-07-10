import Foundation
import PDFKit

// Ensure we have an input file path
guard CommandLine.arguments.count > 1 else {
    print("Error: Missing PDF file path argument.")
    exit(1)
}

let pdfPath = CommandLine.arguments[1]
let fileURL = URL(fileURLWithPath: pdfPath)

// Check if file exists
guard FileManager.default.fileExists(atPath: fileURL.path) else {
    print("Error: File does not exist at path \(pdfPath)")
    exit(1)
}

// Load PDF and extract text
guard let document = PDFDocument(url: fileURL) else {
    print("Error: Failed to load PDF at \(pdfPath)")
    exit(1)
}

var extractedText = ""
for i in 0..<document.pageCount {
    if let page = document.page(at: i), let pageText = page.string {
        extractedText += pageText + "\n"
    }
}

print(extractedText.trimmingCharacters(in: .whitespacesAndNewlines))
