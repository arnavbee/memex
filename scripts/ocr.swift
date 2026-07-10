import Foundation
import Vision
import CoreGraphics
import ImageIO

// Ensure we have an input file path
guard CommandLine.arguments.count > 1 else {
    print("Error: Missing image file path argument.")
    exit(1)
}

let imagePath = CommandLine.arguments[1]
let fileURL = URL(fileURLWithPath: imagePath)

// Check if file exists
guard FileManager.default.fileExists(atPath: fileURL.path) else {
    print("Error: File does not exist at path \(imagePath)")
    exit(1)
}

// Load CGImage using CoreGraphics / ImageIO (fully headless)
guard let imageSource = CGImageSourceCreateWithURL(fileURL as CFURL, nil),
      let cgImage = CGImageSourceCreateImageAtIndex(imageSource, 0, nil) else {
    print("Error: Failed to load image at \(imagePath)")
    exit(1)
}

// Create OCR Request
let requestHandler = VNImageRequestHandler(cgImage: cgImage, options: [:])
let request = VNRecognizeTextRequest { request, error in
    if let error = error {
        print("Error: OCR failed - \(error.localizedDescription)")
        exit(1)
    }
    
    guard let observations = request.results as? [VNRecognizedTextObservation] else {
        return
    }
    
    // Extract and print identified text lines
    for observation in observations {
        if let topCandidate = observation.topCandidates(1).first {
            print(topCandidate.string)
        }
    }
}

// Configure OCR options
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

do {
    try requestHandler.perform([request])
} catch {
    print("Error: Failed to perform text recognition - \(error.localizedDescription)")
    exit(1)
}
