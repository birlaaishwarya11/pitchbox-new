import Anthropic from '@anthropic-ai/sdk';
import type { AnalysisResult } from './CodebaseAnalyzer';
import type { FlowExtractionResult } from './FlowExtractor';

export interface ScriptGenerationOptions {
  style?: 'technical' | 'business' | 'casual';
  targetDuration?: number; // in seconds
  focusAreas?: string[];
  includeCodeExamples?: boolean;
}

export interface DemoScript {
  fullScript: string;
  sections: ScriptSection[];
  estimatedDuration: number;
  keywords: string[];
  metadata: {
    style: string;
    generatedAt: string;
    repository: string;
  };
}

export interface ScriptSection {
  title: string;
  content: string;
  duration: number;
  type: 'introduction' | 'feature' | 'flow' | 'technical' | 'conclusion';
}

export class ScriptGeneratorError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ScriptGeneratorError';
  }
}

export class ScriptGenerator {
  private readonly anthropic: Anthropic;

  constructor(apiKey?: string) {
    if (!apiKey) {
      throw new ScriptGeneratorError('Anthropic API key is required');
    }

    this.anthropic = new Anthropic({ apiKey });
  }

  async generate(
    analysis: AnalysisResult,
    flowResult: FlowExtractionResult,
    repoUrl: string,
    options: ScriptGenerationOptions = {}
  ): Promise<DemoScript> {
    const style = options.style || 'business';
    const targetDuration = options.targetDuration || 180; // 3 minutes default

    try {
      const prompt = this.buildPrompt(analysis, flowResult, repoUrl, options);

      const response = await this.anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 4096,
        temperature: 0.7,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const content = response.content[0];
      if (content.type !== 'text') {
        throw new ScriptGeneratorError('Unexpected response format from Claude');
      }

      const scriptText = content.text;
      const sections = this.parseScriptSections(scriptText, targetDuration);
      const keywords = this.extractKeywords(analysis, flowResult);

      return {
        fullScript: scriptText,
        sections,
        estimatedDuration: sections.reduce((sum, s) => sum + s.duration, 0),
        keywords,
        metadata: {
          style,
          generatedAt: new Date().toISOString(),
          repository: repoUrl,
        },
      };
    } catch (error) {
      if (error instanceof ScriptGeneratorError) {
        throw error;
      }
      throw new ScriptGeneratorError('Failed to generate demo script', error);
    }
  }

  private buildPrompt(
    analysis: AnalysisResult,
    flowResult: FlowExtractionResult,
    repoUrl: string,
    options: ScriptGenerationOptions
  ): string {
    const { style = 'business', targetDuration = 180, focusAreas = [] } = options;

    const context = this.buildContext(analysis, flowResult);

    return `You are a professional product demo script writer. Your task is to create an engaging, natural-sounding demo script for a text-to-speech system (ElevenLabs) that will be used to demonstrate a software product.

# Repository Information
- URL: ${repoUrl}
- Tech Stack: ${analysis.techStack.languages.join(', ')}
- Frameworks: ${analysis.techStack.frameworks.join(', ') || 'None detected'}
- Total Files: ${analysis.totalFiles}

# Project Context
${context}

# Script Requirements
- Style: ${style} (${this.getStyleDescription(style)})
- Target Duration: ${targetDuration} seconds
- Tone: Conversational, engaging, and easy to understand when spoken aloud
${focusAreas.length > 0 ? `- Focus Areas: ${focusAreas.join(', ')}` : ''}

# Instructions
1. Create a compelling demo script that showcases the product's key features and value proposition
2. Structure the script in clear sections: Introduction, Key Features (3-5), User Flow, and Conclusion
3. Write in a natural, conversational tone suitable for voice narration
4. Include natural pauses and transitions
5. Avoid technical jargon unless style is "technical"
6. Make it engaging and highlight what makes this product special
7. Each section should have a clear purpose and flow naturally into the next

# Output Format
Structure your response as follows:

## INTRODUCTION
[Opening that hooks the audience and explains what the product is]

## FEATURE: [Feature Name]
[Explain the feature in an engaging way]

## FEATURE: [Feature Name]
[Explain the feature in an engaging way]

[... more features ...]

## USER FLOW: [Flow Name]
[Walk through a typical user journey]

## CONCLUSION
[Wrap up with value proposition and call-to-action]

Remember: This will be read aloud by a text-to-speech system, so write it as you would speak it. Use short sentences, active voice, and natural language.`;
  }

  private getStyleDescription(style: string): string {
    switch (style) {
      case 'technical':
        return 'Focus on technical implementation, architecture, and developer-facing details';
      case 'business':
        return 'Focus on business value, ROI, and how it solves real problems';
      case 'casual':
        return 'Friendly, approachable tone that feels like a conversation with a colleague';
      default:
        return 'Balanced approach covering both features and benefits';
    }
  }

  private buildContext(analysis: AnalysisResult, flowResult: FlowExtractionResult): string {
    const parts: string[] = [];

    // README content if available
    const readme = analysis.keyFiles.find(f => f.relativePath.toLowerCase().includes('readme'));
    if (readme && readme.content) {
      const excerpt = readme.content.slice(0, 1000);
      parts.push(`## README Excerpt\n${excerpt}`);
    }

    // Features
    if (flowResult.features.length > 0) {
      parts.push(`## Key Features\n${flowResult.features.map(f => `- ${f.name}: ${f.description}`).join('\n')}`);
    }

    // User Flows
    if (flowResult.userFlows.length > 0) {
      parts.push(`## User Flows\n${flowResult.userFlows.map(flow =>
        `- ${flow.name}: ${flow.description}\n  Steps: ${flow.steps.join(' → ')}`
      ).join('\n')}`);
    }

    // API Endpoints
    if (flowResult.apiEndpoints.length > 0) {
      const endpointSummary = flowResult.apiEndpoints.slice(0, 10).map(ep => `${ep.method} ${ep.path}`).join(', ');
      parts.push(`## API Endpoints\n${endpointSummary}`);
    }

    // UI Components
    if (flowResult.uiComponents.length > 0) {
      parts.push(`## UI Components\n${flowResult.uiComponents.slice(0, 15).join(', ')}`);
    }

    // Dependencies
    if (analysis.dependencies.production.length > 0) {
      parts.push(`## Key Dependencies\n${analysis.dependencies.production.slice(0, 10).join(', ')}`);
    }

    return parts.join('\n\n');
  }

  private parseScriptSections(scriptText: string, targetDuration: number): ScriptSection[] {
    const sections: ScriptSection[] = [];
    const lines = scriptText.split('\n');

    let currentSection: Partial<ScriptSection> | null = null;
    let currentContent: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();

      // Check if this is a section header
      if (trimmed.startsWith('## ')) {
        // Save previous section
        if (currentSection && currentContent.length > 0) {
          currentSection.content = currentContent.join('\n').trim();
          sections.push(currentSection as ScriptSection);
        }

        // Start new section
        const title = trimmed.replace('## ', '');
        const type = this.determineSectionType(title);

        currentSection = {
          title,
          type,
          duration: 0, // Will calculate after
        };
        currentContent = [];
      } else if (currentSection && trimmed) {
        currentContent.push(line);
      }
    }

    // Add last section
    if (currentSection && currentContent.length > 0) {
      currentSection.content = currentContent.join('\n').trim();
      sections.push(currentSection as ScriptSection);
    }

    // Calculate durations (rough estimate: 150 words per minute, 2.5 words per second)
    const totalWords = sections.reduce((sum, s) => sum + this.countWords(s.content || ''), 0);
    const wordsPerSecond = totalWords / targetDuration;

    for (const section of sections) {
      const words = this.countWords(section.content);
      section.duration = Math.round(words / wordsPerSecond);
    }

    return sections;
  }

  private determineSectionType(title: string): ScriptSection['type'] {
    const lower = title.toLowerCase();
    if (lower.includes('introduction') || lower.includes('intro')) return 'introduction';
    if (lower.includes('conclusion') || lower.includes('wrap') || lower.includes('closing')) return 'conclusion';
    if (lower.includes('feature')) return 'feature';
    if (lower.includes('flow') || lower.includes('journey')) return 'flow';
    if (lower.includes('technical') || lower.includes('architecture')) return 'technical';
    return 'feature';
  }

  private countWords(text: string): number {
    return text.split(/\s+/).filter(word => word.length > 0).length;
  }

  private extractKeywords(analysis: AnalysisResult, flowResult: FlowExtractionResult): string[] {
    const keywords = new Set<string>();

    // Add tech stack
    analysis.techStack.languages.forEach(lang => keywords.add(lang));
    analysis.techStack.frameworks.forEach(fw => keywords.add(fw));

    // Add feature names
    flowResult.features.forEach(f => keywords.add(f.name));

    // Add flow names
    flowResult.userFlows.forEach(f => keywords.add(f.name));

    return Array.from(keywords).slice(0, 20);
  }
}
