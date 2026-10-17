@abuse @fake-gemini
Feature: Protection against abuse of image questions
  Waleed asked: "Are there any protections against abuse and DDoS attacks?" and
  "Should we make this available only to logged-in users?"

  These scenarios run against a fake Gemini, so flooding the server costs no
  money. What is being tested is the server's own limits, not the model.

  The limits below (20 image questions per hour, 2 at the same time, no images
  for guest accounts) are PROPOSALS. Change the numbers here if we agree on
  different ones. Several of these fail today on purpose: the protection does
  not exist yet.

  Background:
    Given the API is running with a fake Gemini that always answers

  Scenario: Someone without an account cannot send images
    When someone who is not signed in sends a 15 MB image question
    Then the response status is 401

  Scenario: A body over the 16 MB limit that declares its size is refused
    Given I am signed in as a registered user
    When I send a 20 MB image question that declares its size
    Then the response status is 413

  Scenario: A body over the limit that hides its size is cut off early
    Given I am signed in as a registered user
    When I stream a 200 MB image question without declaring its size
    Then the server refuses it before receiving 20 MB

  Scenario: A file that is labelled as an image but is not one is refused
    Given I am signed in as a registered user
    When I send an "image/png" image whose bytes are plain text
    Then the response status is 422

  Scenario: More than 20 image questions in an hour are refused
    Given I am signed in as a registered user
    When I send 21 image questions one after another
    Then the first 20 are answered
    And the last one is refused with status 429

  Scenario: Text questions keep working after the image limit is reached
    Given I am signed in as a registered user
    When I send 21 image questions one after another
    And I ask "What is the first verse of Surah Al-Fatiha?" with no images
    Then I get an answer

  Scenario: More than 2 image questions at the same time are refused
    Given I am signed in as a registered user
    And the fake Gemini takes 5 seconds to answer
    When I send 6 image questions at the same time
    Then at most 2 are answered
    And the rest are refused with status 429

  Scenario: Guest accounts cannot attach images
    Given I am signed in as a guest
    When I ask "What number is written in this image?" with 1 numbered image
    Then the response status is 403

  Scenario: Guest accounts can still ask text questions
    Given I am signed in as a guest
    When I ask "What is the first verse of Surah Al-Fatiha?" with no images
    Then I get an answer
