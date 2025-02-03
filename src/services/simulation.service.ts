import { ethers } from 'ethers';
import { UniswapService } from './uniswap.service';

export class SimulationService {
    private uniswapService: UniswapService;

    constructor() {
        this.uniswapService = new UniswapService();
    }

    async simulateTradeWithHardcodedValues() {
        try {
            // Hardcoded values untuk simulasi
            const tokenIn = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'; // WETH address
            const tokenOut = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // USDC address
            const amountIn = ethers.utils.parseEther('0.1'); // 0.1 ETH
            
            // Simulate getting quote
            const quote = await this.uniswapService.getQuote(
                tokenIn,
                tokenOut,
                amountIn
            );

            // Simulate trade parameters
            const simulatedResult = {
                tokenIn,
                tokenOut,
                amountIn: amountIn.toString(),
                estimatedAmountOut: quote.toString(),
                estimatedGas: '200000',
                simulationTime: new Date().toISOString(),
                success: true
            };

            return simulatedResult;
        } catch (error) {
            console.error('Error in trade simulation:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async simulateMultipleTrades() {
        const scenarios = [
            {
                description: 'ETH to USDC - Small Amount',
                amountIn: '0.1'
            },
            {
                description: 'ETH to USDC - Medium Amount',
                amountIn: '1.0'
            },
            {
                description: 'ETH to USDC - Large Amount',
                amountIn: '5.0'
            }
        ];

        const results = [];

        for (const scenario of scenarios) {
            try {
                const amountIn = ethers.utils.parseEther(scenario.amountIn);
                const result = await this.simulateTradeWithHardcodedValues();
                results.push({
                    ...scenario,
                    result
                });
            } catch (error) {
                results.push({
                    ...scenario,
                    error: error.message
                });
            }
        }

        return results;
    }
} 