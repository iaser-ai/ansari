@inkling
Feature: Image questions work when Inkling answers
  Inkling is Ansari's backup model. It answers when Gemini fails, when Gemini
  returns an empty answer, or when the server runs with Inkling as the main
  model. Waleed's probe showed Inkling can see images, so an image question
  should still get a real answer in all three cases.

  Each test image shows a random number made up for this run. An answer that
  names the number proves the model saw the image, because it cannot guess it.

  Scenario: Inkling as the main model answers an image question
    Given the API is running with Inkling as the main model
    And I am signed in as a registered user
    When I ask "What number is written in this image? Reply with the number only." with 1 numbered image
    Then I get an answer
    And the answer contains the number from every image
    And the answer was written by Inkling

  Scenario: Inkling sees all four images
    Given the API is running with Inkling as the main model
    And I am signed in as a registered user
    When I ask "List every number written in these images, one per line." with 4 numbered images
    Then I get an answer
    And the answer contains the number from every image
    And the answer was written by Inkling

  Scenario: Gemini fails with an error and Inkling rescues the image question
    Given the API is running with a broken Gemini that rejects every call
    And I am signed in as a registered user
    When I ask "What number is written in this image? Reply with the number only." with 1 numbered image
    Then I get an answer
    And the answer contains the number from every image
    And the answer was written by Inkling

  @fake-gemini
  Scenario: Gemini returns an empty answer and Inkling takes over the image question
    Given the API is running with a fake Gemini that always returns an empty answer
    And I am signed in as a registered user
    When I ask "What number is written in this image? Reply with the number only." with 1 numbered image
    Then I get an answer
    And the answer contains the number from every image
    And the answer was written by Inkling

  Scenario: A text question still falls back to Inkling as before
    Given the API is running with a broken Gemini that rejects every call
    And I am signed in as a registered user
    When I ask "What is the first verse of Surah Al-Fatiha?" with no images
    Then I get an answer
    And the answer was written by Inkling
