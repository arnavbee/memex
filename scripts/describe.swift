import Foundation
import Vision
import CoreGraphics
import ImageIO

// Ensure we have an input file path
guard CommandLine.arguments.count > 1 else {
    print("Error: Missing image path.")
    exit(1)
}
let path = CommandLine.arguments[1]
let url = URL(fileURLWithPath: path)
guard FileManager.default.fileExists(atPath: url.path) else {
    print("Error: File not found.")
    exit(1)
}
guard let imageSource = CGImageSourceCreateWithURL(url as CFURL, nil),
      let cgImage = CGImageSourceCreateImageAtIndex(imageSource, 0, nil) else {
    print("Error: Failed to load image.")
    exit(1)
}

// 1. Run Classification
var labels: [String] = []
let classifyRequest = VNClassifyImageRequest { request, error in
    guard let results = request.results as? [VNClassificationObservation] else { return }
    labels = results.prefix(12)
        .filter { $0.confidence > 0.05 }
        .map { $0.identifier }
}

// 2. Run OCR
var ocrLines: [String] = []
let ocrRequest = VNRecognizeTextRequest { request, error in
    guard let results = request.results as? [VNRecognizedTextObservation] else { return }
    ocrLines = results.map { $0.topCandidates(1).first?.string ?? "" }.filter { !$0.isEmpty }
}
ocrRequest.recognitionLevel = .accurate
ocrRequest.usesLanguageCorrection = true

// 3. Perform Vision requests
let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try? handler.perform([classifyRequest, ocrRequest])

// 4. Get Dominant Colors
func getDominantColors(cgImage: CGImage) -> String {
    let width = 30
    let height = 30
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    var rawData = [UInt8](repeating: 0, count: width * height * 4)
    guard let context = CGContext(data: &rawData,
                                  width: width,
                                  height: height,
                                  bitsPerComponent: 8,
                                  bytesPerRow: width * 4,
                                  space: colorSpace,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        return "Unknown"
    }
    context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
    
    var colorCounts: [String: Int] = [:]
    for i in 0..<(width * height) {
        let r = Double(rawData[i * 4]) / 255.0
        let g = Double(rawData[i * 4 + 1]) / 255.0
        let b = Double(rawData[i * 4 + 2]) / 255.0
        
        let maxVal = max(r, max(g, b))
        let minVal = min(r, min(g, b))
        let d = maxVal - minVal
        
        var h: Double = 0
        var s: Double = 0
        let l: Double = (maxVal + minVal) / 2.0
        
        if d > 0 {
            s = l > 0.5 ? d / (2.0 - maxVal - minVal) : d / (maxVal + minVal)
            if maxVal == r {
                h = (g - b) / d + (g < b ? 6.0 : 0.0)
            } else if maxVal == g {
                h = (b - r) / d + 2.0
            } else if maxVal == b {
                h = (r - g) / d + 4.0
            }
            h /= 6.0
        }
        
        let hueDegrees = h * 360.0
        let colorName: String
        if l < 0.12 {
            colorName = "Black"
        } else if l > 0.88 {
            colorName = "White"
        } else if s < 0.15 {
            if l < 0.35 { colorName = "Dark Grey" }
            else if l > 0.65 { colorName = "Light Grey" }
            else { colorName = "Grey" }
        } else {
            switch hueDegrees {
            case 0..<15, 345...360: colorName = l < 0.3 ? "Dark Red" : "Red"
            case 15..<45: colorName = l < 0.45 ? "Brown" : "Orange"
            case 45..<75: colorName = l < 0.4 ? "Olive" : "Yellow"
            case 75..<160: colorName = l < 0.35 ? "Dark Green" : "Green"
            case 160..<200: colorName = l < 0.4 ? "Dark Teal" : "Teal"
            case 200..<260:
                if l < 0.35 { colorName = "Navy Blue" }
                else if s < 0.45 { colorName = "Slate Blue" }
                else if l < 0.55 { colorName = "Blue" }
                else { colorName = "Light Blue" }
            case 260..<300: colorName = "Purple"
            case 300..<345: colorName = "Pink"
            default: colorName = "Unknown"
            }
        }
        colorCounts[colorName, default: 0] += 1
    }
    
    let sortedColors = colorCounts.sorted(by: { $0.value > $1.value })
    return sortedColors.prefix(3).map { "\($0.key) (\(Int(Double($0.value) / 900.0 * 100.0))%)" }.joined(separator: ", ")
}

let dominantColors = getDominantColors(cgImage: cgImage)

// Print unified output
if !ocrLines.isEmpty {
    print("[OCR Text]:")
    print(ocrLines.joined(separator: "\n"))
    print("")
}
print("[Visual Analysis]:")
print("Labels: \(labels.joined(separator: ", "))")
print("Dominant Colors: \(dominantColors)")
