// Print the text the Vision framework reads in an image, one line per observation.
// Used by sim-smoke.sh to check simulator screenshots for what the page says.
//   swift ios/scripts/ocr.swift <image.png>
import Foundation
import Vision

let url = URL(fileURLWithPath: CommandLine.arguments[1])
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
let handler = VNImageRequestHandler(url: url, options: [:])
do {
    try handler.perform([request])
    for o in request.results ?? [] {
        if let t = o.topCandidates(1).first { print(t.string) }
    }
} catch {
    FileHandle.standardError.write("ocr failed: \(error)\n".data(using: .utf8)!)
    exit(1)
}
