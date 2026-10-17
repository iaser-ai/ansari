@real-models @cost
Feature: Cost of an image question
  Waleed asked: "Have you estimated the cost of one of the calls in practice,
  including processing etc?"

  One answer is several model calls: the first call, one per round of tool use,
  and sometimes a final summary call. Every one of them re-sends the images. So
  this measures the whole answer, all calls added up, using the token counts
  the server records for it. Prices per million tokens come from bdd/.env.

  The images are photo-sized (1568 x 1176, the size the app sends after it
  shrinks a phone photo). Every answer's cost goes into the run report.

  The maximum costs below are first guesses. Adjust them once we see real numbers.

  Background:
    Given the API is running with real Gemini
    And I am signed in as a registered user

  Scenario Outline: Cost of one answer with <images> image(s)
    When I ask "<question>" with <images> photo-sized images, 3 times
    Then the median cost of one answer is at most $<max_cost>

    Examples:
      | images | max_cost | question                                                         |
      | 0      | 0.04     | What does Surah Al-Ikhlas teach about God?                       |
      | 1      | 0.02     | What number is written in this image, and is it a prime number?  |
      | 4      | 0.05     | What numbers are written in these images, and which are primes?  |

  Scenario Outline: A realistic image question that searches: <case>
    The questions above about numbers need no search, so they take one model call.
    A real question about a photographed page makes the model search the Quran and
    tafsir first, which takes several calls, and every call re-sends the image. This
    asks for the same explanation with and without the photo, so the difference is
    the image's real cost.

    When I ask "<question>" <how>, 3 times
    Then the median cost of one answer is at most $<max_cost>

    Examples:
      | case               | how                                                  | max_cost | question                                                                       |
      | photo of the page  | with the fixture image "quran-photo-ahzab.png"       | 0.08     | Explain the meaning of the outlined verses in this photo.                      |
      | same request, text | with no images                                       | 0.06     | Explain the meaning of Surah Al-Ahzab, verses 23 and 24.                       |
