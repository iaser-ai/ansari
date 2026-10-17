@real-models @latency
Feature: Latency of an image question
  Waleed asked: "What are the latency impacts of this?"

  Two things add time. Uploading the images (it depends on the user's
  connection, so we report the upload size and the time at a few typical speeds)
  and the model reading the images on every call of the answer (measured here
  against the real model).

  "First word" is the time from sending the question until the first word of the
  answer appears. "Full answer" is the time until the answer is complete. The
  limits below are first guesses. Adjust them once we see real numbers.

  Background:
    Given the API is running with real Gemini
    And I am signed in as a registered user

  Scenario Outline: Latency with <images> image(s)
    When I ask "<question>" with <images> photo-sized images, 3 times
    Then the median time to the first word is at most <max_first> seconds
    And the median time to the full answer is at most <max_total> seconds
    And the upload is at most <max_upload_mb> MB

    Examples:
      | images | max_first | max_total | max_upload_mb | question                                                         |
      | 0      | 10        | 40        | 0.1           | What does Surah Al-Ikhlas teach about God?                       |
      | 1      | 12        | 45        | 1             | What number is written in this image, and is it a prime number?  |
      | 4      | 15        | 50        | 4             | What numbers are written in these images, and which are primes?  |
