import Foundation
import Vision

// Read actual rendered simulator UI using macOS's built-in Vision framework.
// Missing/unreadable markers fail the acceptance script; no synthetic verdict.
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
request.recognitionLanguages = ["en-US"]
let handler = VNImageRequestHandler(url: URL(fileURLWithPath: CommandLine.arguments[1]), options: [:])
try handler.perform([request])
for observation in request.results ?? [] {
  if let candidate = observation.topCandidates(1).first {
    print(candidate.string)
  }
}
