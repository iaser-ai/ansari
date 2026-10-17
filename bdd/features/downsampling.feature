@real-models @downsampling
Feature: Effect of shrinking images on the text in them
  Waleed asked: "If we downsample the image and it's got text in it, does it
  impact the text?"

  Before sending, the app shrinks every picked image so its longest side is at
  most 1568 pixels, and saves it as a JPEG at quality 0.8. Small text, and above
  all Arabic diacritics (tashkeel), are the first things to blur.

  Each image in bdd/fixtures/text-images comes with a .txt file of the same name
  holding its exact text. For each image and each size, the model is asked to
  copy out the text. Then we count how many of the real words appear in its
  answer, once ignoring diacritics and once with them.

  Bigger sizes show whether raising the 1568 limit would help. Inkling is
  included because it now answers image questions when Gemini fails. The
  minimum percentages below are first guesses.

  Scenario Outline: <model> reading text from images shrunk to <size>
    Given the API is running with <model>
    And I am signed in as a registered user
    When the model copies out the text of every fixture image shrunk to <size>
    Then on average at least <min_words>% of the words are read correctly, ignoring diacritics
    And on average at least <min_marked>% of the words are read correctly, with diacritics

    Examples: Gemini
      | model       | size     | min_words | min_marked |
      | real Gemini | 1568 px  | 95        | 85         |
      | real Gemini | 2048 px  | 95        | 85         |
      | real Gemini | 3072 px  | 95        | 85         |
      | real Gemini | original | 95        | 85         |

    Examples: Inkling
      | model                      | size     | min_words | min_marked |
      | Inkling as the main model  | 1568 px  | 95        | 85         |
      | Inkling as the main model  | 3072 px  | 95        | 85         |
