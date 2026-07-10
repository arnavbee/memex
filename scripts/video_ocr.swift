import Foundation
import AVFoundation
import Vision

// Check arguments
guard CommandLine.arguments.count > 1 else {
    print("Usage: swift video_ocr.swift <video-file-path> [interval-seconds]")
    exit(1)
}

let videoPath = CommandLine.arguments[1]
let videoURL = URL(fileURLWithPath: videoPath)

let intervalSeconds: Double
if CommandLine.arguments.count > 2, let interval = Double(CommandLine.arguments[2]) {
    intervalSeconds = interval
} else {
    intervalSeconds = 5.0 // default interval
}

let asset = AVAsset(url: videoURL)
let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
generator.requestedTimeToleranceBefore = .zero
generator.requestedTimeToleranceAfter = .zero

// Get duration
let duration: CMTime
if #available(macOS 12.0, *) {
    let semaphore = DispatchSemaphore(value: 0)
    var loadedDuration: CMTime = .zero
    asset.loadValuesAsynchronously(forKeys: ["duration"]) {
        var error: NSError? = nil
        let status = asset.statusOfValue(forKey: "duration", error: &error)
        if status == .loaded {
            loadedDuration = asset.duration
        }
        semaphore.signal()
    }
    _ = semaphore.wait(timeout: .now() + 5.0)
    duration = loadedDuration
} else {
    duration = asset.duration
}

let durationSeconds = CMTimeGetSeconds(duration)

guard durationSeconds > 0 && !durationSeconds.isNaN else {
    print("Error: Could not retrieve video duration.")
    exit(1)
}

var times = [CMTime]()
for t in stride(from: 0.0, to: durationSeconds, by: intervalSeconds) {
    times.append(CMTime(seconds: t, preferredTimescale: 600))
}

let semaphore = DispatchSemaphore(value: 0)
var results = [Double: String]()
var completedCount = 0

guard !times.isEmpty else {
    print("No timeframes to capture.")
    exit(0)
}

for time in times {
    let timeValue = NSValue(time: time)
    generator.generateCGImagesAsynchronously(forTimes: [timeValue]) { (requestedTime, cgImage, actualTime, result, error) in
        defer {
            completedCount += 1
            if completedCount == times.count {
                semaphore.signal()
            }
        }
        
        guard result == .succeeded, let cgImage = cgImage else {
            return
        }
        
        let requestHandler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        let request = VNRecognizeTextRequest { (request, error) in
            guard let observations = request.results as? [VNRecognizedTextObservation] else { return }
            var frameText = ""
            for observation in observations {
                if let candidate = observation.topCandidates(1).first {
                    frameText += candidate.string + " "
                }
            }
            let trimmed = frameText.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                results[CMTimeGetSeconds(requestedTime)] = trimmed
            }
        }
        request.recognitionLevel = .accurate
        try? requestHandler.perform([request])
    }
}

// Wait for async generation to finish (with a timeout of 30 seconds max)
_ = semaphore.wait(timeout: .now() + 30.0)

// Print results sorted by timestamp
let sortedKeys = results.keys.sorted()
var uniqueTexts = Set<String>()
for key in sortedKeys {
    if let text = results[key] {
        // Simple deduplication of identical adjacent text blocks
        if !uniqueTexts.contains(text) {
            print("[\(Int(key))s]: \(text)")
            uniqueTexts.insert(text)
        }
    }
}
exit(0)
