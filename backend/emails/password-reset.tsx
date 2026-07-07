import {
  Html,
  Head,
  Body,
  Container,
  Text,
  Link,
  Preview,
  Heading,
} from '@react-email/components';
import * as React from 'react';

interface PasswordResetEmailProps {
  resetUrl: string;
}

export default function PasswordResetEmail({ resetUrl }: PasswordResetEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Reset your Ansari password</Preview>
      <Body style={{ fontFamily: 'Arial, sans-serif', backgroundColor: '#f6f6f6', padding: '20px' }}>
        <Container style={{ backgroundColor: '#ffffff', padding: '30px', borderRadius: '5px', maxWidth: '600px' }}>
          <Heading as="h2">Reset your Ansari Password</Heading>
          <Text>Click the link below to reset your password for Ansari.</Text>
          <Text>If you did not request a reset of your Ansari password, you can safely ignore this.</Text>
          <Text>
            Click on <Link href={resetUrl}>this link</Link> to reset your password.
          </Text>
          <Text>Or paste this link into your browser:</Text>
          <Text>{resetUrl}</Text>
        </Container>
      </Body>
    </Html>
  );
}
